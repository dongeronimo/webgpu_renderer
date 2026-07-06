import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { Node } from "../node";
import { RotationBehaviour } from "../rotation_behaviour";
import { World } from "../world";
import { createSyntheticVolume } from "./syntheticVolume";
import { TextureSliceGenerator } from "../textureStackVolumeRender/textureSliceGenerator";
import { TextureStackTransparentMaterial } from "../textureStackVolumeRender/textureStackTransparentMaterial";
import { TransparentSlicesRenderPass } from "../textureStackVolumeRender/TransparentSlicesRenderPass";

/**
 * O primeiro tipo de volume renderer que vamos explorar, baseado em uma série de planos
 * cortando a imagem 3d, sampleando-a e usando blending para compor a imagem final.
 *
 * Este mundo usa o FANTOMA SINTÉTICO como dado; as peças da técnica (pass,
 * SliceMesh, generator, material) moram em ../textureStackVolumeRender/ e
 * são compartilhadas com o futuro mundo de dados reais (loader do
 * dicom_converter) — a única diferença entre os mundos é a origem da
 * textura 3D.
 */
export class TextureStackVolumeRendererSynthetic extends World {
    private canvas!: HTMLCanvasElement;
    private slicesPass!: TransparentSlicesRenderPass;
    private finalPass!: FinalRenderPass;
    //criados no createWorld; o mundo destrói os dois no destroy()
    private material!: TextureStackTransparentMaterial;
    private generator!: TextureSliceGenerator;
    /**
     * Vai ter os passes TransparentPass, Final pass, com a composição sendo no final
     * pass.
     */
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.slicesPass = new TransparentSlicesRenderPass(this.device, canvasFormat);
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }
    /**
     * O volume é um fantoma sintético gerado na hora (HU de verdade:
     * ar/tecido/osso), com uma CTF hardcoded no material.
     *
     * A cena: câmera olhando a origem + nó-pilha com o TextureSliceGenerator,
     * que cria os nós-fatia como filhos dele no primeiro update. O nó-pilha
     * gira devagar (RotationBehaviour) — movimento relativo câmera↔volume é
     * o que exercita a regeneração das fatias a cada frame.
     */
    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //câmera
        const camNode = new Node();
        camNode.name = "Camera";
        camNode.position[0] = 0;
        camNode.position[1] = 0.6;
        camNode.position[2] = 2.2;
        camNode.camera = new Camera();
        camNode.camera.aspect = perspective.aspect;
        camNode.camera.fovY = perspective.fovy;
        camNode.camera.near = perspective.near;
        camNode.camera.far = perspective.far;
        this.rootNode.addChild(camNode);
        camNode.lookAt(new Float32Array([0, 0, 0]));

        //volume: textura 3D + material com uma CTF HARDCODED pro fantoma
        //(ar/tecido/osso). Este mundo não ouve o state ctf do redux de
        //propósito: o papel dele é ser o caso mínimo da técnica — a curva
        //editável é assunto do mundo CT.
        this.material = new TextureStackTransparentMaterial(
            this.device,
            createSyntheticVolume(this.device, 128),
            [
                //ar transparente; tecido mole avermelhado e rala; osso branco denso
                { hu: -1000, r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
                { hu: -100, r: 0.8, g: 0.4, b: 0.3, a: 0.0 },
                { hu: 40, r: 0.9, g: 0.55, b: 0.45, a: 0.2 },
                { hu: 400, r: 0.95, g: 0.9, b: 0.8, a: 0.55 },
                { hu: 1000, r: 1.0, g: 1.0, b: 1.0, a: 0.95 },
            ],
            //alphaScale baixo de propósito: as esferas do fantoma são
            //ENORMES (centenas de slabs de travessia) — com o default 0.3,
            //calibrado pra estruturas anatômicas finas, virariam um bloco
            //opaco e o osso interno sumiria
            0.05,
        );

        //nó-pilha: a caixa do volume é [-0.5, 0.5]³ no espaço local dele;
        //as fatias nascem como filhos, criadas pelo generator
        const stackNode = new Node();
        stackNode.name = "Volume";
        this.generator = new TextureSliceGenerator(this.device, this.material, 128);
        this.generator.node = stackNode;
        stackNode.behaviours.push(this.generator);
        //rotação lenta pra dar paralaxe sem controle de câmera (por ora)
        const spin = new RotationBehaviour();
        spin.node = stackNode;
        stackNode.behaviours.push(spin);
        this.rootNode.addChild(stackNode);
    }
    /**
     * Renderiza as fatias, na ordem de trás pra frente: ou seja de mais longe da camera pra mais
     * perto da camera. (A ordem é garantida pelo generator: o nó-fatia i
     * sempre recebe o i-ésimo plano contando de trás.)
     */
    render(encoder: GPUCommandEncoder): void {
        //resize primeiro, pra todos os passes verem o mesmo tamanho
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        //fatias → alvo offscreen do slices pass (ele limpa e blenda)
        this.slicesPass.render(encoder, this.rootNode, width, height);
        //composição do offscreen no backbuffer
        this.finalPass.render(encoder, this.slicesPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (este mundo não usa o registry)
        this.generator.destroy(); //as SliceMesh são do generator
        this.material.destroy(); //textura 3D + params (não registrado)
        this.slicesPass.destroy();
        this.finalPass.destroy();
    }
}
