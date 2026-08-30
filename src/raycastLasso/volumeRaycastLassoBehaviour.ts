//O "cérebro" do raycaster do LASSO. Clone do VolumeRaycastESSBehaviour
//(../raycastESS/) — mesmo sync lastSeen de CTF + alpha + gradiente + o recálculo
//do skip-map quando a CTF muda.
//
//É o ponto de entrada UI→engine deste mundo: quando o estado dos lassos entrar
//no redux (lista + cursor de undo/redo), é aqui que o lastSeen dele vira uma
//chamada de setLassos no material — mesmo padrão do setSkipMap, comparando a
//lista por REFERÊNCIA (o reducer cria array novo a cada mudança).
//
//A ocupação estática (1 u32/chunk) e o binning vêm no construtor — o world os
//carrega uma vez (loadChunkOccupancy) e injeta aqui. O skip-map INICIAL é
//responsabilidade do world (ele o calcula e chama setSkipMap na criação), então
//o 1º update não conta como mudança — mesmo padrão do setCtf no baseline.
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { ctfVisibleMask, computeSkipMap } from "../raycastESS/chunkOccupancy";
import { VolumeRaycastLassoMaterial } from "./volumeRaycastLassoMaterial";

export class VolumeRaycastLassoBehaviour extends Behaviour {
    private lastCtf = store.getState().ctf.points;
    private lastAlpha = store.getState().textureBasedCT.alphaScale;
    private lastGradientEnabled = store.getState().raycast.gradientEnabled;
    private lastGradientMode = store.getState().raycast.gradientMode;
    private lastEssEnabled = store.getState().raycast.essEnabled;
    //Os lassos, pelo MESMO critério da CTF: comparação por referência. O
    //lassoReducer cria array novo a cada adição/remoção, então "mudou" é
    //`!==` e nada de varrer a lista todo frame.
    private lastLassos = store.getState().lasso.items;
    private lastLassoDebug = store.getState().raycast.lassoDebugView;
    private lastScalpels = store.getState().scalpel.items;
    private lastScalpelDebug = store.getState().raycast.scalpelDebugView;

    constructor(
        private readonly material: VolumeRaycastLassoMaterial,
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
        //LASSOS: fechou um no overlay (ou o undo tirou um), a referência troca
        //e o material recebe a lista nova. Rebuild de recurso de GPU é caro, e
        //por isso mora aqui e não num subscribe do redux: acontece UMA vez por
        //edição, no update do frame seguinte, e nunca no meio de um frame.
        const lassos = store.getState().lasso.items;
        if (lassos !== this.lastLassos) {
            this.lastLassos = lassos;
            this.material.setLassos(lassos);
        }
        //Debug view das máscaras: só um float nos params, sem rebuild nenhum.
        if (raycast.lassoDebugView !== this.lastLassoDebug) {
            this.lastLassoDebug = raycast.lassoDebugView;
            this.material.setLassoDebug(raycast.lassoDebugView);
        }
        //BISTURIS: mesmo padrão, mas MUITO mais caro do outro lado — cada
        //mudança recaptura os mapas de profundidade (um render por bisturi).
        //Por isso a comparação por referência importa ainda mais aqui: um
        //`!==` frouxo custaria um punhado de raymarches por frame.
        const scalpels = store.getState().scalpel.items;
        if (scalpels !== this.lastScalpels) {
            this.lastScalpels = scalpels;
            this.material.setScalpels(scalpels);
        }
        if (raycast.scalpelDebugView !== this.lastScalpelDebug) {
            this.lastScalpelDebug = raycast.scalpelDebugView;
            this.material.setScalpelDebug(raycast.scalpelDebugView);
        }
    }
}
