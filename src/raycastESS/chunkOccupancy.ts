//Empty-space skipping (Design A): a decisão de pular é feita na CPU sempre que
//a CTF muda, e o único dado que vai pra GPU é o resultado (1 valor por chunk).
//
//As três peças CPU-side moram aqui:
//  1. loadChunkOccupancy — carrega chunk_histograms.bin (saída do
//     dicom_converter.py) e o REDUZ a uma máscara de OCUPAÇÃO por chunk: um
//     u32 onde o bit b diz "este chunk tem algum voxel no bin b?". Estático
//     (intrínseco do volume), calculado uma vez no load. Counts viram bits
//     porque pra pular só importa PRESENÇA, não quantidade.
//  2. ctfVisibleMask — dos pontos da CTF atual, quais bins têm alpha>0 (u32).
//     Recalculado a cada mudança de CTF.
//  3. computeSkipMap — o AND: um chunk é PROCESSADO sse (ocupação & visíveis)
//     != 0; senão é pulado. É o skip-map que sobe pro shader.
//
//A grade de chunk e o binning vêm do metadata. Assume histogramBins <= 32
//(cabe num u32) — a saída padrão do conversor usa 32. Acima disso, a máscara
//teria que virar um array de u32 (nem CPU nem shader mudam muito, mas fica pra
//quando precisar).
import type { CtfPoint } from "../ctf";
import type { VolumeMetadata } from "../volume-types";

//Alpha abaixo disto conta como "invisível" — o mesmo espírito da CTF bem
//formada que começa em alpha 0 (ver ctf.ts).
const ALPHA_EPS = 1e-4;

/**
 * Carrega o chunk_histograms.bin e o reduz à máscara de ocupação por chunk
 * (1 u32/chunk, bit b = bin b tem contagem > 0). O array tem totalChunks
 * elementos, na MESMA ordem row-major (z,y,x) do arquivo e do
 * chunkHistogramOffset.
 */
export async function loadChunkOccupancy(
    baseUrl: string,
    metadata: VolumeMetadata,
): Promise<Uint32Array> {
    const { totalChunks, histogramBins } = metadata;
    if (histogramBins > 32) {
        throw new Error(
            `loadChunkOccupancy: histogramBins=${histogramBins} > 32 não cabe numa máscara u32 ` +
            `(a v1 do ESS assume <=32 bins — regere com --histogram-bins <=32 ou generalize pra multi-word).`,
        );
    }
    const url = `${baseUrl}/chunk_histograms.bin`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Falha ao buscar ${url}: HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const expected = totalChunks * histogramBins * 4; //uint32
    if (buffer.byteLength !== expected) {
        //pega .bin truncado E o fallback index.html do Vite (tamanho não bate)
        throw new Error(
            `${url}: esperados ${expected} bytes (${totalChunks}×${histogramBins}×4), vieram ${buffer.byteLength}.`,
        );
    }
    const counts = new Uint32Array(buffer);
    const occupancy = new Uint32Array(totalChunks);
    for (let c = 0; c < totalChunks; c++) {
        const base = c * histogramBins;
        let mask = 0;
        for (let b = 0; b < histogramBins; b++) {
            if (counts[base + b] > 0) {
                mask |= 1 << b; //b até 31: o bit 31 vira negativo, o >>> 0 abaixo conserta
            }
        }
        occupancy[c] = mask >>> 0;
    }
    return occupancy;
}

//Alpha da CTF em `hu`: piecewise-linear entre pontos de controle (ordenados
//por HU — invariante do reducer), clamp-to-edge fora do domínio, igual ao
//sampler da LUT. Sem pontos ⇒ 0.
function ctfAlphaAt(points: readonly CtfPoint[], hu: number): number {
    if (points.length === 0) return 0;
    if (hu <= points[0].hu) return points[0].a;
    const last = points[points.length - 1];
    if (hu >= last.hu) return last.a;
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i + 1];
        if (hu <= p1.hu) {
            const p0 = points[i];
            const span = p1.hu - p0.hu;
            const t = span > 0 ? (hu - p0.hu) / span : 0;
            return p0.a + (p1.a - p0.a) * t;
        }
    }
    return last.a;
}

/**
 * Máscara dos bins VISÍVEIS pra CTF atual: bit b setado sse existe algum HU no
 * intervalo do bin b com alpha > EPS. Como o alpha é piecewise-linear, o máximo
 * no intervalo está SEMPRE numa das pontas ou num ponto de controle interno —
 * então basta testar as duas bordas + os pontos de controle que caem dentro do
 * bin (nada de amostrar o intervalo inteiro). Conservador de propósito: se o
 * alpha encosta em >0 em qualquer lugar do bin, o bin conta como visível.
 */
export function ctfVisibleMask(
    points: readonly CtfPoint[],
    bins: number,
    hMin: number,
    hMax: number,
): number {
    const binW = (hMax - hMin) / bins;
    let mask = 0;
    for (let b = 0; b < bins; b++) {
        const lo = hMin + b * binW;
        const hi = hMin + (b + 1) * binW;
        let visible = ctfAlphaAt(points, lo) > ALPHA_EPS || ctfAlphaAt(points, hi) > ALPHA_EPS;
        if (!visible) {
            for (const p of points) {
                if (p.hu > lo && p.hu < hi && p.a > ALPHA_EPS) {
                    visible = true;
                    break;
                }
            }
        }
        if (visible) {
            mask |= 1 << b;
        }
    }
    return mask >>> 0;
}

/**
 * O AND por chunk: out[c] = 1 (PROCESSA) sse ocupação & visíveis != 0, senão 0
 * (PULA). Um u32 por chunk — sem bit-packing na v1, pro shader ler direto sem
 * shift/mask (12 KB pro exame do abdômen, cache-resident).
 */
export function computeSkipMap(occupancy: Uint32Array, visibleMask: number): Uint32Array<ArrayBuffer> {
    const out = new Uint32Array(occupancy.length);
    for (let c = 0; c < occupancy.length; c++) {
        out[c] = (occupancy[c] & visibleMask) !== 0 ? 1 : 0;
    }
    return out;
}
