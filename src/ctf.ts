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
