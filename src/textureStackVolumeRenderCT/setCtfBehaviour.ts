//Behaviour que liga a tabela de CTF do redux ao material — irmã da
//SetNumSlicesBehaviour, mesmo padrão lastSeen (getState() no update, sem
//subscribe). A diferença: aqui a comparação é por REFERÊNCIA do array de
//pontos, que funciona porque o ctfReducer cria array novo a cada set —
//imutabilidade do redux virando detector de mudança de graça.
//
//Recebe o material direto no construtor (em vez de caçá-lo na árvore):
//no createWorld o material já existe quando a behaviour é criada, e é o
//MESMO objeto a vida inteira do mundo.
//
//Pendura no nó-pilha junto com generator/spin/numSlices — a arquitetura de
//behaviours compondo comportamentos num nó, agora com quatro de uma vez.
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { TextureStackTransparentMaterial } from "../textureStackVolumeRender/textureStackTransparentMaterial";
import { TextureStackPrecalculatedMaterial } from "./textureStackPrecalculatedGradientMaterial";

export class SetCtfBehaviour extends Behaviour {
    //inicia com a tabela corrente: o material nasceu com ela (o mundo a lê
    //do store no createWorld), então o primeiro update não conta como mudança
    private lastSeen = store.getState().ctf.points;

    constructor(private readonly material: TextureStackTransparentMaterial|TextureStackPrecalculatedMaterial) {
        super();
    }

    update(_deltaTime: number): void {
        const points = store.getState().ctf.points;
        if (points === this.lastSeen) {
            return;
        }
        this.lastSeen = points;
        this.material.setCtf(points);
    }
}
