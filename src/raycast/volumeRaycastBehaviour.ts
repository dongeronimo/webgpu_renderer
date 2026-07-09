//O "cérebro" do raycaster: a behaviour que mantém o VolumeRaycastMaterial em
//sincronia com o estado da app. Por ora o trabalho é ligar o mesmo sistema
//de CTF e de alpha do textureStackVolumeRenderCT ao material — assim os
//sliders do painel Render (CT) já controlam o raycaster quando ele é o mundo
//ativo. Mesmo padrão lastSeen das SetCtfBehaviour/SetAlphaScaleBehaviour
//(getState() no update, sem subscribe): a imutabilidade do redux vira
//detector de mudança de graça.
//
//Recebe o material direto no construtor: no createWorld ele já existe quando
//a behaviour é criada, e é o MESMO objeto a vida inteira do mundo.
//
//É aqui que a inteligência futura do raycaster vai crescer (empty-space
//skipping, controle de qualidade/passo, câmera etc.) — daí "cérebro".
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { VolumeRaycastMaterial } from "./volumeRaycastMaterial";

export class VolumeRaycastBehaviour extends Behaviour {
    //O material nasce com estes valores (o mundo os lê do store no
    //createWorld), então o primeiro update não conta como mudança.
    private lastCtf = store.getState().ctf.points;
    private lastAlpha = store.getState().textureBasedCT.alphaScale;

    constructor(private readonly material: VolumeRaycastMaterial) {
        super();
    }

    update(_deltaTime: number): void {
        //CTF: comparação por REFERÊNCIA (o ctfReducer cria array novo a cada set)
        const points = store.getState().ctf.points;
        if (points !== this.lastCtf) {
            this.lastCtf = points;
            this.material.setCtf(points);
        }
        //alphaScale: o mesmo knob do mundo CT
        const alpha = store.getState().textureBasedCT.alphaScale;
        if (alpha !== this.lastAlpha) {
            this.lastAlpha = alpha;
            this.material.setAlphaScale(alpha);
        }
    }
}
