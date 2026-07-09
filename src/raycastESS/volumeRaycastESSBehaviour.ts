//O "cérebro" do raycaster com ESS. Clone do VolumeRaycastBehaviour (../raycast/)
//— mesmo sync lastSeen de CTF + alpha + gradiente — MAIS o empty-space skipping:
//  - quando a CTF muda, além de rebakear a tabela (setCtf), refaz o SKIP-MAP na
//    CPU (Design A: visibleMask a partir dos pontos, AND com a ocupação
//    estática) e o reenvia com setSkipMap;
//  - quando o essEnabled do redux muda, liga/desliga o skip no material.
//
//A ocupação estática (1 u32/chunk) e o binning vêm no construtor — o world os
//carrega uma vez (loadChunkOccupancy) e injeta aqui. O skip-map INICIAL é
//responsabilidade do world (ele o calcula e chama setSkipMap na criação), então
//o 1º update não conta como mudança — mesmo padrão do setCtf no baseline.
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { ctfVisibleMask, computeSkipMap } from "./chunkOccupancy";
import { VolumeRaycastESSMaterial } from "./volumeRaycastESSMaterial";

export class VolumeRaycastESSBehaviour extends Behaviour {
    private lastCtf = store.getState().ctf.points;
    private lastAlpha = store.getState().textureBasedCT.alphaScale;
    private lastGradientEnabled = store.getState().raycast.gradientEnabled;
    private lastGradientMode = store.getState().raycast.gradientMode;
    private lastEssEnabled = store.getState().raycast.essEnabled;

    constructor(
        private readonly material: VolumeRaycastESSMaterial,
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
    }
}
