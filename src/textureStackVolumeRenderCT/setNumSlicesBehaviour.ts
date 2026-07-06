//Behaviour que liga o slider de fatias da UI ao generator: ouve o redux
//pelo padrão lastSeen das behaviours (getState() no update, sem subscribe
//— callback nenhum segurando nó de mundo morto) e, quando
//textureBasedCT.numSlices muda, acha a TextureSliceGenerator pendurada no
//MESMO nó e troca o sliceCount dela. Também avisa o MATERIAL (injetado no
//construtor, como na SetCtfBehaviour): ele precisa da contagem pra
//correção de opacidade — sem isso o slider de fatias também mudaria a
//densidade acumulada da imagem.
//
//Bônus do polling: n dispatches no mesmo frame (slider arrastando) viram
//UMA troca — a behaviour só vê o valor uma vez por frame.
//
//Pendura no nó-pilha junto com a generator, à mão no createWorld (não está
//no registry: é específica do mundo CT).
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { TextureSliceGenerator } from "../textureStackVolumeRender/textureSliceGenerator";
import { TextureStackTransparentMaterial } from "../textureStackVolumeRender/textureStackTransparentMaterial";
import { TextureStackPrecalculatedMaterial } from "./textureStackPrecalculatedGradientMaterial";

export class SetNumSlicesBehaviour extends Behaviour {
    //inicia com o valor corrente do store: generator E material nascem com
    //ele, então o primeiro update não conta como mudança
    private lastSeen = store.getState().textureBasedCT.numSlices;

    constructor(private readonly material: TextureStackTransparentMaterial|TextureStackPrecalculatedMaterial) {
        super();
    }

    update(_deltaTime: number): void {
        const numSlices = store.getState().textureBasedCT.numSlices;
        if (numSlices === this.lastSeen) {
            return;
        }
        this.lastSeen = numSlices;
        const generator = this.node.behaviours.find(
            (b): b is TextureSliceGenerator => b instanceof TextureSliceGenerator,
        );
        if (!generator) {
            console.warn(`SetNumSlicesBehaviour: nó "${this.node.name}" não tem TextureSliceGenerator.`);
            return;
        }
        generator.setSliceCount(numSlices);
        this.material.setSliceCount(numSlices); //correção de opacidade
    }
}
