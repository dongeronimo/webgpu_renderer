//Rasterização de um contorno numa MÁSCARA 2D — serve o lasso E o bisturi — a peça que troca o
//laço de segmentos do shader por um fetch de textura.
//
//Por quê: o teste dentro/fora não depende de t, nem de profundidade, nem de
//nada 3D — depende só do (x,y) em que o ponto cai no NDC daquele lasso. É uma
//função de duas variáveis, e função de duas variáveis com domínio limitado é
//exatamente o que uma textura guarda. Varrer 50 segmentos por amostra, por
//lasso, com cada pixel gastando um número diferente de iterações (o warp
//esperando o mais lento) vira um textureSampleLevel de custo fixo.
//
//A máscara cobre o NDC INTEIRO ([-1,1]² = a tela toda no instante do traço),
//em uv: u = x*0.5+0.5 e v = 0.5 - y*0.5 (o v cresce pra baixo, o NDC pra cima).
//O shader faz essa mesma conta com o ponto projetado.

/** Lado da máscara em texels. 512² = 256 KB por contorno em r8unorm. */
export const CONTOUR_MASK_SIZE = 512;

/**
 * Rasteriza o contorno (NDC, x/y intercalados, ABERTO — o fechamento
 * último→primeiro é implícito) numa máscara `size`×`size` de 1 byte por texel:
 * 255 dentro, 0 fora.
 *
 * Regra NONZERO, a mesma que o canvas do overlay usa na prévia. Even-odd
 * furaria o meio de um traço que se auto-intersecta — e traço à mão livre se
 * auto-intersecta o tempo todo. Se as duas regras divergirem, a prévia passa a
 * mentir sobre o corte.
 */
export function rasterizeContourMask(points: Float32Array, size = CONTOUR_MASK_SIZE): Uint8Array<ArrayBuffer> {
    const mask = new Uint8Array(size * size);
    const n = points.length / 2;
    if (n < 3) {
        return mask;
    }

    //NDC → espaço de texel, uma vez só (o laço de linhas relê isto size vezes)
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        px[i] = (points[i * 2] * 0.5 + 0.5) * size;
        py[i] = (0.5 - points[i * 2 + 1] * 0.5) * size;
    }

    //Scanline: pra cada linha, acha onde as arestas a cruzam, ordena por x e
    //anda da esquerda pra direita somando a DIREÇÃO de cada cruzamento. Onde a
    //soma (o winding) é diferente de zero, está dentro.
    const xs: number[] = [];
    const dirs: number[] = [];
    for (let row = 0; row < size; row++) {
        //centro do texel: rasterizar pela borda deixaria a linha de cima
        //sempre meio texel torta
        const y = row + 0.5;
        xs.length = 0;
        dirs.length = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n; //%n = o fechamento implícito
            const y0 = py[i];
            const y1 = py[j];
            if (y0 === y1) {
                continue; //aresta horizontal não cruza scanline nenhuma
            }
            //Intervalo SEMI-ABERTO [min,max): sem isso um vértice exatamente na
            //altura da linha seria contado pelas duas arestas que o tocam, e o
            //winding sairia errado dali pra direita.
            if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
                const t = (y - y0) / (y1 - y0);
                xs.push(px[i] + t * (px[j] - px[i]));
                dirs.push(y1 > y0 ? 1 : -1);
            }
        }
        if (xs.length < 2) {
            continue;
        }
        //ordena os índices (e não os xs) pra dir e x continuarem pareados
        const order = xs.map((_, k) => k).sort((a, b) => xs[a] - xs[b]);
        let winding = 0;
        for (let k = 0; k < order.length - 1; k++) {
            winding += dirs[order[k]];
            if (winding === 0) {
                continue; //este vão está FORA
            }
            //Preenche os texels cujo CENTRO (x+0.5) cai em [xa, xb).
            const xa = xs[order[k]];
            const xb = xs[order[k + 1]];
            const from = Math.max(Math.ceil(xa - 0.5), 0);
            const to = Math.min(Math.ceil(xb - 0.5), size);
            const base = row * size;
            for (let x = from; x < to; x++) {
                mask[base + x] = 255;
            }
        }
    }

    //ANEL DE BORDA ZERADO. O sampler é clamp-to-edge: um uv fora de [0,1]
    //repete o texel da borda, então um traço encostado na beirada da tela
    //"vazaria" pro infinito e removeria o que está fora do NDC. Zerar o anel
    //faz o clamp devolver "fora", que é a resposta certa.
    const last = size - 1;
    for (let x = 0; x < size; x++) {
        mask[x] = 0;
        mask[last * size + x] = 0;
    }
    for (let row = 0; row < size; row++) {
        mask[row * size] = 0;
        mask[row * size + last] = 0;
    }
    return mask;
}
