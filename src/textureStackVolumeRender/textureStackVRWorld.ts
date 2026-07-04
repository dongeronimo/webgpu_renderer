import { World } from "../world";

/**
 * O primeiro tipo de volume renderer que vamos explorar, baseado em uma série de planos 
 * cortando a imagem 3d, sampleando-a e usando blending para compor a imagem final.
 */
export class TextureStackVolumeRenderer extends World {
    /**
     * Vai ter os passes TransparentPass, Final pass, com a composição sendo no final 
     * pass. 
     */
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        throw new Error("Method not implemented.");
    }
    /**
     * Vai procurar a imagem já montada no localStorage. Se não encontrar carrega ela e a
     * salva no localStorage.
     * 
     * Uma vez tendo a imagem cria a texture 3d e cria a lista de slices (a definir como serão
     * esses slices) que samplerarão a textura 3d. 
     */
    createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    /**
     * Renderiza as fatias, na ordem de trás pra frente: ou seja de mais longe da camera pra mais 
     * perto da camera.
     */
    render(encoder: GPUCommandEncoder): void {
        throw new Error("Method not implemented.");
    }
}
