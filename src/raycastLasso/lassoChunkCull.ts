//ESS ciente do LASSO: marcar como "pula" o chunk que está INTEIRO dentro de um
//lasso de remoção (ou inteiro fora de um lasso de recorte).
//
//Sem isto o empty-space skipping continua CORRETO — ele só pula o que é
//comprovadamente vazio, e o lasso remove a mais — mas não ganha nada com o
//corte: o raio segue marchando passo a passo por dentro de um buraco. Com isto,
//furar um pedaço grande do exame devolve velocidade, que é justamente o caso em
//que o zoom deixava o render lento.
//
//A PERGUNTA e a estrutura que a responde
//
//Um chunk está inteiro dentro do lasso se a projeção dele cabe dentro da
//máscara. Projetamos os 8 cantos do AABB com a clipFromLocal e ficamos com a
//BBOX em NDC dos pontos projetados — um superset da projeção real, então o erro
//é sempre pro lado seguro: no máximo deixamos de pular um chunk que daria pra
//pular, nunca pulamos algo visível.
//
//Aí a pergunta vira "este RETÂNGULO está todo dentro da máscara?", e é pra isso
//que existe a SUMMED-AREA TABLE: com ela a resposta é 4 lookups e uma
//comparação (soma == área × 255), independente do tamanho do retângulo. Sem
//ela seria varrer os texels do retângulo por chunk, que com milhares de chunks
//não fecha a conta.
//
//SÓ LASSO. A região do bisturi é limitada em profundidade e o mapa da camada
//dele mora na GPU — testar chunk contra ela exigiria readback, e uma casca fina
//quase nunca contém um chunk inteiro. O ganho real está no lasso, que remove
//uma pirâmide infinita.
import type { LassoData } from "./lassoData";
import { CONTOUR_MASK_SIZE, rasterizeContourMask } from "./contourMask";
import { ctfVisibleMask, computeSkipMap } from "../raycastESS/chunkOccupancy";
import type { CtfPoint } from "../ctf";

/** A grade de chunks no espaço LOCAL do volume (a caixa [-0.5,0.5]³). */
export interface ChunkGridLocal {
    /** nº de chunks por eixo. */
    numChunks: [number, number, number];
    /** Lado do chunk em uvw (chunkSize/dim por eixo) = lado no espaço local. */
    chunkCell: [number, number, number];
}

const SAT_STRIDE = CONTOUR_MASK_SIZE + 1;

/**
 * Summed-area table da máscara: sat[y][x] = soma de todos os texels acima e à
 * esquerda. Uma linha e uma coluna a mais, zeradas, pra a consulta não precisar
 * de caso especial na borda.
 *
 * Uint32 cabe: 512×512×255 = 66.8M, bem abaixo de 2³².
 */
function buildSat(mask: Uint8Array): Uint32Array {
    const sat = new Uint32Array(SAT_STRIDE * SAT_STRIDE);
    for (let y = 0; y < CONTOUR_MASK_SIZE; y++) {
        const maskRow = y * CONTOUR_MASK_SIZE;
        const prevRow = y * SAT_STRIDE;
        const row = (y + 1) * SAT_STRIDE;
        let running = 0;
        for (let x = 0; x < CONTOUR_MASK_SIZE; x++) {
            running += mask[maskRow + x];
            sat[row + x + 1] = sat[prevRow + x + 1] + running;
        }
    }
    return sat;
}

/** Soma dos texels em [x0,x1) × [y0,y1). Índices já em texels, clampados. */
function rectSum(sat: Uint32Array, x0: number, y0: number, x1: number, y1: number): number {
    if (x1 <= x0 || y1 <= y0) {
        return 0;
    }
    return sat[y1 * SAT_STRIDE + x1]
        - sat[y0 * SAT_STRIDE + x1]
        - sat[y1 * SAT_STRIDE + x0]
        + sat[y0 * SAT_STRIDE + x0];
}

/**
 * As SATs vivas, uma por lasso, indexadas pelo id.
 *
 * Existe porque o skip-map é recalculado toda vez que a CTF muda — e arrastar
 * um ponto no editor de CTF dispara isso a cada evento do mouse. Rerasterizar
 * 512² por lasso a cada quadro de arrasto travaria a edição; a máscara, porém,
 * depende só dos pontos do contorno, que são imutáveis. Então rasteriza uma vez
 * por lasso e guarda.
 */
export class LassoSatCache {
    private readonly sats = new Map<number, Uint32Array>();

    /** A SAT do lasso, construída na primeira vez que for pedida. */
    get(lasso: LassoData): Uint32Array {
        let sat = this.sats.get(lasso.id);
        if (sat === undefined) {
            sat = buildSat(rasterizeContourMask(lasso.points, CONTOUR_MASK_SIZE));
            this.sats.set(lasso.id, sat);
        }
        return sat;
    }

    /** Descarta as SATs de lassos que saíram da lista (undo, remoção). */
    prune(lassos: readonly LassoData[]): void {
        const alive = new Set(lassos.map((l) => l.id));
        for (const id of [...this.sats.keys()]) {
            if (!alive.has(id)) {
                this.sats.delete(id);
            }
        }
    }
}

/**
 * O skip-map do ESS levando os lassos em conta: primeiro o skip-map normal
 * (ocupação do chunk × bins visíveis na CTF), depois zerando os chunks que
 * algum lasso já removeu por inteiro.
 *
 * Devolve array novo — é ele que sobe pra GPU.
 */
export function skipMapWithLassos(
    occupancy: Uint32Array,
    ctfPoints: readonly CtfPoint[],
    histogramBins: number,
    histogramMin: number,
    histogramMax: number,
    lassos: readonly LassoData[],
    grid: ChunkGridLocal,
    sats: LassoSatCache,
): Uint32Array<ArrayBuffer> {
    const skip = computeSkipMap(
        occupancy,
        ctfVisibleMask(ctfPoints, histogramBins, histogramMin, histogramMax),
    );
    if (lassos.length === 0) {
        return skip;
    }
    sats.prune(lassos);

    const [nx, ny, nz] = grid.numChunks;
    const [cx, cy, cz] = grid.chunkCell;
    //Reusado a cada chunk pra não alocar dezenas de milhares de arrays.
    const corner = new Float32Array(3);

    for (const lasso of lassos) {
        const sat = sats.get(lasso);
        const m = lasso.clipFromLocal;
        for (let z = 0; z < nz; z++) {
            for (let y = 0; y < ny; y++) {
                for (let x = 0; x < nx; x++) {
                    const flat = (z * ny + y) * nx + x;
                    if (skip[flat] === 0) {
                        continue; //já vai ser pulado por estar vazio
                    }
                    //AABB do chunk no espaço local. O último chunk de um eixo
                    //pode ser parcial e estourar a caixa — uma caixa maior que
                    //a real só torna os testes abaixo mais difíceis de passar,
                    //que é o lado seguro.
                    const lo0 = x * cx - 0.5;
                    const lo1 = y * cy - 0.5;
                    const lo2 = z * cz - 0.5;

                    let uMin = Infinity;
                    let uMax = -Infinity;
                    let vMin = Infinity;
                    let vMax = -Infinity;
                    let behind = false;
                    for (let c = 0; c < 8; c++) {
                        corner[0] = lo0 + ((c & 1) !== 0 ? cx : 0);
                        corner[1] = lo1 + ((c & 2) !== 0 ? cy : 0);
                        corner[2] = lo2 + ((c & 4) !== 0 ? cz : 0);
                        //mat4 column-major × vec4(corner,1)
                        const cw = m[3] * corner[0] + m[7] * corner[1] + m[11] * corner[2] + m[15];
                        if (cw <= 0) {
                            behind = true; //atrás do olho congelado: desiste
                            break;
                        }
                        const cxp = m[0] * corner[0] + m[4] * corner[1] + m[8] * corner[2] + m[12];
                        const cyp = m[1] * corner[0] + m[5] * corner[1] + m[9] * corner[2] + m[13];
                        //NDC → uv com o y invertido, a MESMA conta do shader
                        const u = (cxp / cw) * 0.5 + 0.5;
                        const v = -(cyp / cw) * 0.5 + 0.5;
                        uMin = Math.min(uMin, u);
                        uMax = Math.max(uMax, u);
                        vMin = Math.min(vMin, v);
                        vMax = Math.max(vMax, v);
                    }
                    if (behind) {
                        continue;
                    }

                    if (!lasso.keep) {
                        //REMOVE: só pula se a bbox INTEIRA estiver dentro da
                        //máscara. Bbox que escapa do NDC tem parte fora do
                        //recorte por definição, então nem testa.
                        if (uMin < 0 || vMin < 0 || uMax > 1 || vMax > 1) {
                            continue;
                        }
                        const x0 = Math.floor(uMin * CONTOUR_MASK_SIZE);
                        const y0 = Math.floor(vMin * CONTOUR_MASK_SIZE);
                        const x1 = Math.min(Math.ceil(uMax * CONTOUR_MASK_SIZE), CONTOUR_MASK_SIZE);
                        const y1 = Math.min(Math.ceil(vMax * CONTOUR_MASK_SIZE), CONTOUR_MASK_SIZE);
                        const area = (x1 - x0) * (y1 - y0);
                        if (area > 0 && rectSum(sat, x0, y0, x1, y1) === area * 255) {
                            skip[flat] = 0;
                        }
                    } else {
                        //KEEP: pula se a bbox estiver INTEIRA fora da máscara —
                        //nada ali sobrevive ao recorte. Aqui clampar é correto:
                        //o que cai fora do NDC também está fora do recorte, e o
                        //anel de borda da máscara é zero de propósito.
                        const x0 = Math.max(Math.floor(uMin * CONTOUR_MASK_SIZE), 0);
                        const y0 = Math.max(Math.floor(vMin * CONTOUR_MASK_SIZE), 0);
                        const x1 = Math.min(Math.ceil(uMax * CONTOUR_MASK_SIZE), CONTOUR_MASK_SIZE);
                        const y1 = Math.min(Math.ceil(vMax * CONTOUR_MASK_SIZE), CONTOUR_MASK_SIZE);
                        if (rectSum(sat, x0, y0, x1, y1) === 0) {
                            skip[flat] = 0;
                        }
                    }
                }
            }
        }
    }
    return skip;
}
