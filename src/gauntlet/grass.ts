/**
 * A metade-CLIENT do contrato da grama.
 *
 * O server manda UM valor por célula (extra `grassSeed`, ver
 * GameMap.EXTRA_GRASS_SEED no Java) e este módulo o expande em N tufos. A rede
 * nunca manda tufo: 8 chars de hex viram uma moita inteira aqui. Não é procgen
 * compartilhado — o client não regenera mapa nenhum, ele desempacota um valor
 * pronto pra decorar uma célula que já recebeu descrita.
 *
 * Divisão de trabalho aqui dentro:
 *  - decodeGrassSeed: desempacota o fio. É contrato, tem que casar com o Java.
 *  - hash32/rand01:   os dados viciados. Determinísticos e portáveis (ver abaixo).
 *  - generateGrassBlades: ONDE cada tufo vai. É a decisão artística, e é o único
 *    lugar deste arquivo que se pode reescrever sem falar com o server.
 *
 * Quem chama é o GauntletNetwork, uma vez por célula, no mapSync — a partir daí
 * a grama é geometria estática igual ao chão.
 */

/** `grassSeed` desempacotado. */
export interface GrassSeed {
    /** 0..255. Quanto o SERVER quer de grama nesta célula — ele decide porque a
     *  densidade vem da forma da dungeon (abertura da célula), que só ele
     *  conhece. Nunca 0: célula sem grama não tem o extra. */
    density: number;
    /** 24 bits. A entrada do hash — mesma seed, mesma moita, sempre, nos 4
     *  clients da instância. */
    seed: number;
}

/** Um tufo, em coordenadas de CÉLULA — quem traduz pra mundo é o
 *  GauntletNetwork (ele é o dono da transformação célula→mundo). Assim o
 *  gerador não precisa saber nada de tileWidth, de centralização do mapa nem
 *  de qual prefab é a arte. */
export interface GrassBlade {
    /** Posição dentro da célula, 0..1 (0 = borda oeste/norte, 1 = leste/sul).
     *  Nada impede passar um pouco disso se você QUISER transbordar a borda. */
    u: number;
    v: number;
    /** Rotação em torno de Y, em GRAUS (é o que Node.eulerAngles quer). */
    yaw: number;
    /** Escala uniforme. 1 = o tamanho que o tufo tem no grass00.glb. */
    scale: number;
}

/** Prefab da arte (registrado em GauntletWorld.loadGrass). */
export const GRASS_PREFAB = "grass00";

/** Teto de tufos por célula. Não é gosto: é orçamento. Cada tufo vira um Node
 *  SKINNED instanciado, com pose própria no pool — e não só do
 *  GauntletSkinnedRenderPass: o GauntletShadowPass escreve o dele DE NOVO, por
 *  luz que projeta sombra. Um mapa 32×32 tem ~500 células de chão, então este
 *  número multiplica por 500 o custo.
 *
 *  Ao mexer aqui, olhe o painel: `traverse` (percurso da árvore) e `render`
 *  (montagem dos draws + escrita das poses) são os dois que respondem, e o
 *  contador de nodes ao lado é o denominador.
 *
 *  O GauntletNetwork TRUNCA no que passar disto (e avisa uma vez). */
export const GRASS_MAX_BLADES_PER_CELL = 8;

/** Lado do sub-grid de amostragem, DERIVADO do teto: casas = 2× o número
 *  máximo de tufos (teto 8 ⇒ 4×4 = 16 casas).
 *
 *  Derivado, e não constante à mão, porque o sorteio é sem repetição — um tufo
 *  por casa. Pedir mais tufos que casas não tem resposta, e o sintoma seria
 *  posição NaN em silêncio, não erro. Amarrando os dois, mexer no teto não
 *  consegue mais quebrar o gerador.
 *
 *  O fator 2 é a folga, e ela paga duas coisas: arranjos diferentes entre
 *  células de MESMA densidade (senão todas as células cheias ocupam exatamente
 *  as mesmas casas e o padrão aparece de longe), sem afrouxar tanto a
 *  estratificação a ponto de voltar a fazer grumo. */
const GRASS_SUBGRID = Math.ceil(Math.sqrt(GRASS_MAX_BLADES_PER_CELL * 2));

/**
 * Hash 32-bit determinístico. É o `Math.imul` que faz isto funcionar: sem ele a
 * multiplicação vira double e perde os bits de cima silenciosamente, e aí
 * "mesma seed, mesmo resultado" para de valer sem avisar.
 *
 * Inteiro puro DE PROPÓSITO, nada de `fract(sin(x)*43758.5453)`: `sin` não é
 * bit-exato entre CPU, GPU e drivers, então no dia em que esta expansão virar
 * compute shader (é o destino natural — ver GRASS_MAX_BLADES_PER_CELL), o WGSL
 * traduz linha a linha e dá o MESMO resultado, porque `u32` lá tem wraparound
 * definido pela spec igual ao `Math.imul` aqui.
 */
export function hash32(a: number, b = 0, c = 0): number {
    let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return h >>> 0;
}

/** Hash → [0, 1). */
export function rand01(h: number): number {
    return (h >>> 0) / 4294967296;
}

/** Densidade do fio (0..255) → quantidade de tufos (0..max). Atalho pra quem
 *  quiser o mapeamento óbvio; o gerador não é obrigado a usar. */
export function bladesForDensity(density: number, max = GRASS_MAX_BLADES_PER_CELL): number {
    return Math.round((density / 255) * max);
}

//Formato malformado avisa UMA vez, não uma por célula (seriam centenas). O caso
//real disto é skew de versão: client novo lendo server velho ou vice-versa.
let warnedBadSeed = false;

/**
 * Desempacota o extra `grassSeed`: u32 em 8 hex minúsculos, 8 bits altos de
 * densidade + 24 baixos de seed. CONTRATO — mexer aqui exige mexer no
 * MapGenerator do Java junto.
 *
 * undefined = célula sem grama (o extra ausente é a forma normal de dizer isso,
 * densidade 0 não existe no fio) ou valor que não dá pra ler.
 */
export function decodeGrassSeed(hex: string | undefined): GrassSeed | undefined {
    if (hex === undefined) return undefined;
    if (!/^[0-9a-f]{8}$/.test(hex)) {
        if (!warnedBadSeed) {
            warnedBadSeed = true;
            console.warn(`grass: grassSeed fora do formato ("${hex}"), esperado 8 hex — ignorando`);
        }
        return undefined;
    }
    const packed = Number.parseInt(hex, 16);
    return { density: (packed >>> 24) & 0xff, seed: packed & 0xffffff };
}

/**
 * ONDE ficam os tufos de UMA célula. É a peça artística, o resto deste arquivo
 * é encanamento e contrato.
 *
 * Regras que não dá pra quebrar:
 *  - PURA e DETERMINÍSTICA: mesma entrada, mesma saída, sempre. Os 4 players da
 *    instância recebem o mesmo `grass` e têm que ver a mesma moita. Nada de
 *    Math.random(), Date.now() ou estado de módulo aqui dentro.
 *  - Sem alocar mundo: devolve DADO. Quem faz node é o GauntletNetwork.
 *  - No máximo GRASS_MAX_BLADES_PER_CELL tufos (acima disso é truncado).
 *
 * cellX/cellZ entram na conta pra duas células com a mesma seed não saírem
 * gêmeas  e porque um dia pode-se querer continuidade ATRAVÉS da borda
 * (hashear a célula vizinha e alinhar), que é impossível se a função só
 * enxergar a seed.
 *
 * O que está implementado aqui é jittered grid, a receita padrão: divide a
 * célula num sub-grid, sorteia QUAIS sub-células recebem tufo e desloca cada
 * tufo dentro da sua. É REFERÊNCIA, não decisão final — serve pra acender a
 * tela e validar o shader; reescrever daqui pra baixo não afeta mais nada.
 *
 * @param cellX coluna da célula no grid do mapa
 * @param cellZ linha da célula no grid do mapa
 * @param grass o que o server mandou pra esta célula, já desempacotado
 */
export function generateGrassBlades(cellX: number, cellZ: number, grass: GrassSeed): GrassBlade[] {
    const slotCount = GRASS_SUBGRID * GRASS_SUBGRID;
    //O clamp faz valer o invariante de GRASS_SUBGRID mesmo que alguém suba só o
    //teto: sem ele o sorteio sem repetição fica sem casa pra sortear e as
    //posições excedentes saem NaN — bug silencioso, tufo que some sem erro.
    const n = Math.min(bladesForDensity(grass.density), slotCount);
    if (n === 0) return [];
    //Tudo desta célula pendura NESTE hash: a seed do fio misturada com a
    //posição. Colisão em 24 bits acontece num mapa de mil células, e sem o
    //cellX/cellZ duas células que colidissem sairiam gêmeas, lado a lado.
    const base = hash32(grass.seed, cellX, cellZ);
    //Quais sub-células recebem tufo, por Fisher-Yates PARCIAL (só os n
    //primeiros). Escolher n de 16 sem repetir é o que mantém a distribuição
    //ESTRATIFICADA: random puro em [0,1)² faz grumo num canto e deixa buraco no
    //outro, que é justamente o que denuncia grama procedural.
    const slots = new Uint8Array(slotCount);
    for (let i = 0; i < slots.length; i++) slots[i] = i;
    const blades: GrassBlade[] = [];
    for (let i = 0; i < n; i++) {
        const j = i + (hash32(base, i) % (slots.length - i));
        const slot = slots[j];
        slots[j] = slots[i]; //meio-swap: índice < i nunca mais é sorteado
        //Jitter DENTRO da sub-célula. Sem ele o sub-grid vira grid VISÍVEL —
        //os tufos saem alinhados em fileira e o olho pega na hora.
        const h = hash32(base, slot, 0x9e37);
        const su = slot % GRASS_SUBGRID;
        const sv = (slot / GRASS_SUBGRID) | 0;
        blades.push({
            u: (su + rand01(h)) / GRASS_SUBGRID,
            v: (sv + rand01(hash32(h, 1))) / GRASS_SUBGRID,
            yaw: rand01(hash32(h, 2)) * 360,
            scale: 0.75 + rand01(hash32(h, 3)) * 0.5,
        });
    }
    return blades;
}
