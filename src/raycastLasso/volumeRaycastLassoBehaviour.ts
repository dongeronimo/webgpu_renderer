//O "cérebro" do raycaster com LASSO. Clone da VolumeRaycastESSBehaviour
//(../raycastESS/) — mesmo sync lastSeen de CTF + alpha + gradiente + skip-map —
//MAIS a sincronização da pilha de lassos.
//
//A parte interessante é a CAPTURA DA MATRIZ. O redux guarda só o polígono em
//NDC: o React desenha e não conhece o scene graph. Quem completa o lasso é
//aqui, no primeiro frame em que um id novo aparece na lista — o `captured` é o
//cache id → (proj*view*model) daquele instante.
//
//INVARIANTE de que isso depende: enquanto o modo lasso está ligado, o App
//monta o LassoOverlay NO LUGAR do OrbitControls, então a câmera não se mexe
//entre o começo do traço e o commit. A matriz capturada no commit é, por
//construção, a mesma de quando o usuário começou a desenhar.
//
//Sobre ler a worldMatrix da câmera no update() (e não no lateUpdate): o nó da
//câmera é o PRIMEIRO filho do root e a travessia é pré-ordem, então quando
//esta behaviour (pendurada no volume) roda, a matriz da câmera já é a deste
//frame. E como a órbita está congelada no modo lasso, mesmo um frame de atraso
//daria a mesma matriz.
import { mat4 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import type { Node } from "../node";
import { store } from "../redux/store";
import { ctfVisibleMask, computeSkipMap } from "../raycastESS/chunkOccupancy";
import type { LassoRecord } from "./lasso";
import { MAX_VERTICES_PER_LASSO } from "./lasso";
import type { GpuLasso } from "./volumeRaycastLassoMaterial";
import { VolumeRaycastLassoMaterial } from "./volumeRaycastLassoMaterial";

export class VolumeRaycastLassoBehaviour extends Behaviour {
    private lastCtf = store.getState().ctf.points;
    private lastAlpha = store.getState().textureBasedCT.alphaScale;
    private lastGradientEnabled = store.getState().raycast.gradientEnabled;
    private lastGradientMode = store.getState().raycast.gradientMode;
    private lastEssEnabled = store.getState().raycast.essEnabled;
    //A pilha: lastLassos pega ADD/CLEAR (array novo) e lastCursor pega
    //UNDO/REDO (o array é o MESMO, só o cursor anda) — precisa dos dois.
    private lastLassos: readonly LassoRecord[] | null = null;
    private lastCursor = -1;
    /** id → clipFromLocal (proj*view*model) congelada no desenho daquele lasso. */
    private readonly captured = new Map<number, Float32Array>();

    constructor(
        private readonly material: VolumeRaycastLassoMaterial,
        //o nó da câmera, pra congelar view+proj no instante do commit
        private readonly cameraNode: Node,
        //ocupação estática (bit por bin, 1 u32/chunk) + binning, pro recálculo
        //do skip-map quando a CTF muda.
        private readonly occupancy: Uint32Array,
        private readonly histogramBins: number,
        private readonly histogramMin: number,
        private readonly histogramMax: number,
    ) {
        super();
    }

    update(_deltaTime: number): void {
        //CTF: comparação por REFERÊNCIA (o ctfReducer cria array novo a cada set)
        const points = store.getState().ctf.points;
        if (points !== this.lastCtf) {
            this.lastCtf = points;
            this.material.setCtf(points);
            //CTF mudou → refaz o skip-map (a única parte por-CTF do ESS)
            const mask = ctfVisibleMask(points, this.histogramBins, this.histogramMin, this.histogramMax);
            this.material.setSkipMap(computeSkipMap(this.occupancy, mask));
        }
        //alphaScale: o mesmo knob do mundo CT
        const alpha = store.getState().textureBasedCT.alphaScale;
        if (alpha !== this.lastAlpha) {
            this.lastAlpha = alpha;
            this.material.setAlphaScale(alpha);
        }
        //gradiente: enable + modo (mesmo lastSeen do baseline)
        const raycast = store.getState().raycast;
        if (raycast.gradientEnabled !== this.lastGradientEnabled ||
            raycast.gradientMode !== this.lastGradientMode) {
            this.lastGradientEnabled = raycast.gradientEnabled;
            this.lastGradientMode = raycast.gradientMode;
            this.material.setGradientShading(
                raycast.gradientEnabled,
                raycast.gradientMode === "on-the-fly",
            );
        }
        //ESS on/off (pra A/B de velocidade)
        if (raycast.essEnabled !== this.lastEssEnabled) {
            this.lastEssEnabled = raycast.essEnabled;
            this.material.setEmptySpaceSkip(raycast.essEnabled);
        }
        //LASSO: pilha ou cursor mudou → remonta os buffers. O 1º update sempre
        //cai aqui (lastLassos = null) e manda a lista vazia, que é o estado
        //correto de partida.
        const lasso = store.getState().lasso;
        if (lasso.lassos !== this.lastLassos || lasso.cursor !== this.lastCursor) {
            this.lastLassos = lasso.lassos;
            this.lastCursor = lasso.cursor;
            this.syncLassos(lasso.lassos, lasso.cursor);
        }
    }

    /**
     * Monta os registros de GPU dos lassos ATIVOS (os `cursor` primeiros — o
     * resto é a cauda de redo, que existe no state mas não corta nada).
     */
    private syncLassos(all: readonly LassoRecord[], cursor: number): void {
        //Poda o cache pelos ids que sumiram da lista INTEIRA (não da fatia
        //ativa!): desenhar depois de um undo descarta a cauda de redo, e são
        //essas matrizes que podem ir embora. As de um lasso só desfeito têm que
        //sobreviver, senão o redo capturaria a câmera de AGORA.
        const alive = new Set(all.map((record) => record.id));
        for (const id of [...this.captured.keys()]) {
            if (!alive.has(id)) {
                this.captured.delete(id);
            }
        }
        const gpu: GpuLasso[] = [];
        for (const record of all.slice(0, cursor)) {
            const points = record.points.length / 2 > MAX_VERTICES_PER_LASSO
                //rede de segurança: a UI já simplifica, mas um polígono absurdo
                //custaria caro POR AMOSTRA. Decima uniformemente em vez de
                //truncar (truncar deixaria o polígono aberto num rabicho).
                ? decimate(record.points, MAX_VERTICES_PER_LASSO)
                : record.points;
            gpu.push({
                clipFromLocal: this.matrixFor(record.id),
                points: new Float32Array(points),
                op: record.op === "remove-inside" ? 0 : 1,
            });
        }
        this.material.setLassos(gpu);
    }

    /**
     * A matriz do lasso `id`, congelando a câmera atual na primeira vez que ele
     * aparece. Inclui a `model` do volume de propósito: o corte fica colado na
     * peça, então girar o volume leva o buraco junto.
     */
    private matrixFor(id: number): Float32Array {
        const cached = this.captured.get(id);
        if (cached) {
            return cached;
        }
        const camera = this.cameraNode.camera;
        if (!camera) {
            throw new Error("VolumeRaycastLassoBehaviour: o nó de câmera não tem componente Camera.");
        }
        //view = inversa da matriz de mundo do nó da câmera (mesma convenção do
        //MeshRenderPass); proj sai do componente, já com o aspect do frame.
        const view = mat4.invert(this.cameraNode.worldMatrix);
        const viewProj = mat4.multiply(camera.getProjectionMatrix(), view);
        //cópia PRÓPRIA: a worldMatrix do nó é reescrita todo frame, e o
        //resultado da wgpu-matrix pode compartilhar buffer com o destino.
        const frozen = new Float32Array(mat4.multiply(viewProj, this.node.worldMatrix));
        this.captured.set(id, frozen);
        return frozen;
    }
}

/** Reamostra um polígono pra no máximo `max` vértices, mantendo o fechamento. */
function decimate(points: readonly number[], max: number): number[] {
    const n = points.length / 2;
    const stride = n / max;
    const out: number[] = [];
    for (let i = 0; i < max; i = i + 1) {
        const src = Math.floor(i * stride) * 2;
        out.push(points[src], points[src + 1]);
    }
    return out;
}
