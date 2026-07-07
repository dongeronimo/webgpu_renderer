//Color Transfer Function: a curva que mapeia HU → cor + opacidade. O dado
//são PONTOS DE CONTROLE (CtfPoint, ordenados por HU); a GPU consome a
//versão RASTERIZADA — uma LUT 1D (512×1 rgba8) que o material sampleia
//pelo HU normalizado. Este módulo é o rasterizador.
//
//Mora no nível do engine (e não em textureStackVolumeRender/) porque a CTF
//é da MODALIDADE, não da técnica: o futuro raycaster consome exatamente a
//mesma LUT. Pela mesma razão os pontos vivem num state redux próprio (ctf),
//não no state do mundo CT.
//
//Domínio da LUT: [primeiro ponto, último ponto]. Fora dele quem responde é
//o clamp-to-edge do sampler, que estende as cores das pontas — por isso
//uma CTF bem formada começa com alpha 0 (tudo abaixo some) e o último
//ponto é a cor do material mais denso.

export interface CtfPoint {
    /** Posição no eixo de HU (Hounsfield). */
    hu: number;
    /** Cor e opacidade em [0,1]. O alpha ainda é escalado pelo alphaScale do material. */
    r: number;
    g: number;
    b: number;
    a: number;
}

/** Largura da LUT: 512 texels cobrem ~1500 HU com ~3 HU/texel — de sobra. */
export const CTF_LUT_WIDTH = 512;

export interface BakedCtf {
    /** width×1 rgba8unorm, pronto pro writeTexture (o generic explícito
     *  é o que o writeTexture aceita — mesmo caso do updateVertices). */
    data: Uint8Array<ArrayBuffer>;
    /** Domínio coberto pela LUT (uniform do material normaliza o HU com eles). */
    huMin: number;
    huMax: number;
}

/**
 * Rasteriza os pontos de controle (JÁ ordenados por HU — invariante do
 * reducer) em texels rgba8, interpolação linear por segmento. O texel i é
 * avaliado no CENTRO dele — assim o shader sampleia com o u cru
 * (hu-min)/(max-min) e acerta os valores sem meio-texel de correção.
 */
export function bakeCtfLut(points: readonly CtfPoint[], width = CTF_LUT_WIDTH): BakedCtf {
    const data = new Uint8Array(width * 4);
    if (points.length === 0) {
        //LUT toda transparente; domínio arbitrário só pra não dividir por zero
        return { data, huMin: 0, huMax: 1 };
    }
    const huMin = points[0].hu;
    const huMax = points[points.length - 1].hu;
    const range = Math.max(huMax - huMin, 1e-6); //1 ponto ⇒ LUT constante

    let seg = 0; //segmento corrente — hu só cresce, então o cursor só avança
    for (let i = 0; i < width; i++) {
        const hu = huMin + ((i + 0.5) / width) * range;
        while (seg < points.length - 2 && points[seg + 1].hu < hu) {
            seg++;
        }
        const p0 = points[seg];
        const p1 = points[Math.min(seg + 1, points.length - 1)];
        const span = p1.hu - p0.hu;
        const t = span > 0 ? Math.min(Math.max((hu - p0.hu) / span, 0), 1) : 0;
        data[i * 4 + 0] = Math.round((p0.r + (p1.r - p0.r) * t) * 255);
        data[i * 4 + 1] = Math.round((p0.g + (p1.g - p0.g) * t) * 255);
        data[i * 4 + 2] = Math.round((p0.b + (p1.b - p0.b) * t) * 255);
        data[i * 4 + 3] = Math.round((p0.a + (p1.a - p0.a) * t) * 255);
    }
    return { data, huMin, huMax };
}

//======================= PRÉ-INTEGRAÇÃO (Engel) =======================
//Engel/Kraus/Ertl 2001. Em vez de amostrar a CTF num ponto por slab, o
//shader amostra o PAR (sf, sb) = HU na frente e no fundo de um slab (dois
//fetches do volume, um passo de fatia adiante) e indexa esta tabela 2D
//T[sf][sb], que guarda a cor+opacidade JÁ integradas ao longo da rampa
//linear sf→sb. É o que mata o onion-ring: features estreitas da CTF que
//caíam ENTRE duas amostras agora entram pela integral da rampa.
//
//A tabela NÃO depende da espessura do slab (nº de fatias): ela é integrada
//na resolução de REFERÊNCIA e o material corrige pra N fatias com o mesmo
//opacityExponent do caminho pontual (1-(1-a)^(REF/N)) — isso deixa a
//correção fisicamente exata (1-exp(-∫τ)) e evita rebake quando o slider de
//fatias mexe. Rebake só quando a CTF muda, como o bakeCtfLut.
//
//Convenção da textura: x (coluna) = sf (frente), y (linha) = sb (fundo).
//Diagonal sf==sb reproduz EXATAMENTE a CTF pontual de hoje.

/** Lado da tabela 2D: cobre o domínio da CTF nos dois eixos. 256 ⇒ ~6
 *  HU/célula em ~1500 HU. rgba8 256² = 256 KB. */
export const PREINT_TABLE_SIZE = 256;

/** Substeps da integral de cada célula ao longo da rampa sf→sb. */
const PREINT_SUBSTEPS = 32;

export interface BakedPreInt {
    /** size×size rgba8unorm (x=sf, y=sb), pronto pro writeTexture. */
    data: Uint8Array<ArrayBuffer>;
    /** Lado da tabela (writeTexture precisa dele em bytesPerRow/rowsPerImage). */
    size: number;
    /** Domínio coberto (o material normaliza sf/sb com ele, igual à LUT 1D). */
    huMin: number;
    huMax: number;
}

/**
 * Rasteriza a tabela de pré-integração a partir dos pontos de controle (JÁ
 * ordenados por HU). Para cada célula (sf, sb) integra a rampa linear
 * sf→sb compondo front-to-back em espaço de EXTINÇÃO — a opacidade `a` da
 * CTF é tratada como opacidade de UM slab de referência, virando extinção
 * τ = -ln(1-a); a rampa é fatiada em PREINT_SUBSTEPS e composta. Assim a
 * diagonal (sf==sb) devolve a=a(s) e rgb=cor(s) idênticos ao ponto — o
 * resto do fragment (alphaScale, correção por N) não muda.
 *
 * Guarda cor DIRETA (não pré-multiplicada): o blend do material é
 * src-alpha, então o hardware multiplica pelo alpha na composição.
 *
 * Custo O(size²·substeps); as transcendentais saem do laço quente via um
 * lut 1D pré-computado (aSub por HU). Roda só no rebake da CTF. (Dá pra
 * baixar pra O(size²) com integrais acumuladas 1D — otimização pra depois.)
 */
export function bakePreIntegrationTable(
    points: readonly CtfPoint[],
    size = PREINT_TABLE_SIZE,
): BakedPreInt {
    const data = new Uint8Array(size * size * 4);
    if (points.length === 0) {
        return { data, size, huMin: 0, huMax: 1 };
    }
    const huMin = points[0].hu;
    const huMax = points[points.length - 1].hu;
    const range = Math.max(huMax - huMin, 1e-6);

    //CTF 1D em alta resolução (float, sem quantizar) pra amostrar a rampa
    //barato. Guardo cor + aSub (opacidade de 1/substeps de um slab de
    //referência) já pré-computados — o laço quente não faz log/exp.
    const RES = 1024;
    const lutR = new Float32Array(RES);
    const lutG = new Float32Array(RES);
    const lutB = new Float32Array(RES);
    const lutASub = new Float32Array(RES);
    let seg = 0;
    for (let i = 0; i < RES; i++) {
        const hu = huMin + ((i + 0.5) / RES) * range;
        while (seg < points.length - 2 && points[seg + 1].hu < hu) {
            seg++;
        }
        const p0 = points[seg];
        const p1 = points[Math.min(seg + 1, points.length - 1)];
        const span = p1.hu - p0.hu;
        const t = span > 0 ? Math.min(Math.max((hu - p0.hu) / span, 0), 1) : 0;
        lutR[i] = p0.r + (p1.r - p0.r) * t;
        lutG[i] = p0.g + (p1.g - p0.g) * t;
        lutB[i] = p0.b + (p1.b - p0.b) * t;
        const a = Math.min(Math.max(p0.a + (p1.a - p0.a) * t, 0), 0.9999);
        //τ do slab de referência inteiro; 1/substeps dele = extinção do substep
        const tau = -Math.log(1 - a);
        lutASub[i] = 1 - Math.exp(-tau / PREINT_SUBSTEPS);
    }
    const idxOf = (hu: number): number => {
        let idx = Math.round(((hu - huMin) / range) * RES - 0.5);
        if (idx < 0) idx = 0;
        else if (idx > RES - 1) idx = RES - 1;
        return idx;
    };

    for (let j = 0; j < size; j++) {         //linha = sb (fundo)
        const sb = huMin + ((j + 0.5) / size) * range;
        for (let i = 0; i < size; i++) {     //coluna = sf (frente)
            const sf = huMin + ((i + 0.5) / size) * range;
            //composição front-to-back da rampa sf→sb (premultiplicado)
            let accR = 0, accG = 0, accB = 0, accA = 0;
            for (let k = 0; k < PREINT_SUBSTEPS; k++) {
                const hu = sf + (sb - sf) * ((k + 0.5) / PREINT_SUBSTEPS);
                const idx = idxOf(hu);
                const aSub = lutASub[idx];
                const trans = 1 - accA;
                accR += trans * aSub * lutR[idx];
                accG += trans * aSub * lutG[idx];
                accB += trans * aSub * lutB[idx];
                accA += trans * aSub;
            }
            //des-premultiplica pra cor direta (blend src-alpha do material)
            const inv = accA > 1e-6 ? 1 / accA : 0;
            const o = (j * size + i) * 4;
            data[o + 0] = Math.round(Math.min(accR * inv, 1) * 255);
            data[o + 1] = Math.round(Math.min(accG * inv, 1) * 255);
            data[o + 2] = Math.round(Math.min(accB * inv, 1) * 255);
            data[o + 3] = Math.round(Math.min(accA, 1) * 255);
        }
    }
    return { data, size, huMin, huMax };
}
