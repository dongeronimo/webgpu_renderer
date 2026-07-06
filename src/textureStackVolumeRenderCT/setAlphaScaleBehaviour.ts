import { Behaviour } from "../behaviour";
import { store } from "../redux/store";
import { TextureStackTransparentMaterial } from "../textureStackVolumeRender/textureStackTransparentMaterial";
import { TextureStackPrecalculatedMaterial } from "./textureStackPrecalculatedGradientMaterial";
// Ouve o textureBasedCT.alphaScale e atualiza o alpha scale do material.
// Ele assume, assim como o SetCtfBehaviour, que está pendurado em um Node que tem volume renderer
export class SetAlphaScaleBehaviour extends Behaviour {
    constructor(private readonly material: TextureStackTransparentMaterial|TextureStackPrecalculatedMaterial) {
        super();
    }

    update(_deltaTime: number): void {
        const alphaScale = store.getState().textureBasedCT.alphaScale;
        this.material.setAlphaScale(alphaScale);
    }
}
