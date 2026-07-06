import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { Node } from "../node";
import { RotationBehaviour } from "../rotation_behaviour";
import { World } from "../world";
import { loadVolumeTexture } from "../volumeLoader";
import { dicomTagNumber } from "../volume-types";
import { TextureSliceGenerator } from "../textureStackVolumeRender/textureSliceGenerator";
import { SetNumSlicesBehaviour } from "./setNumSlicesBehaviour";
import { SetCtfBehaviour } from "./setCtfBehaviour";
import { store } from "../redux/store";
import { TransparentSlicesRenderPass } from "../textureStackVolumeRender/TransparentSlicesRenderPass";
import { SetAlphaScaleBehaviour } from "./setAlphaScaleBehaviour";
import { createGradientTexture, gradientParamsFromMetadata } from "./gradientCompute";
import { TextureStackPrecalculatedMaterial } from "./textureStackPrecalculatedGradientMaterial";
import { DebugSlicesPass } from "./debugSlicesRenderPass";
import { DebugOverlayPass } from "./debugOverlayPass";

const VOLUME_URL = "/volumes/abdomen-feet-first";

/**
 * O VR por fatias com um CT DE VERDADE: a saída do dicom_converter.py
 * servida de public/volumes/. As peças da técnica (pass, SliceMesh,
 * generator, material) moram em ../textureStackVolumeRender/ e são as
 * mesmas do mundo sintético — a diferença é a origem da textura 3D, as
 * proporções físicas vindas do metadata e a CTF vinda do redux (editável).
 */
export class TextureStackVolumeRendererCT extends World {
    private canvas!: HTMLCanvasElement;
    private slicesPass!: TransparentSlicesRenderPass;
    private finalPass!: FinalRenderPass;
    //passes de DEBUG (picture-in-picture): renderiza as fatias de uma câmera
    //em órbita pra um alvo offscreen (debugSlicesPass) e desenha esse alvo
    //num quadzinho no canto, por cima do final (debugOverlayPass).
    private debugSlicesPass!: DebugSlicesPass;
    private debugOverlayPass!: DebugOverlayPass;
    //liga/desliga a view de debug (quadzinho no canto). Sempre true por hora;
    //vira knob de UI/redux depois. Off = pula os dois passes de debug.
    private debugViewEnabled = true;
    //câmera principal, guardada pra passar ao debug pass (que a orbita)
    private camNode!: Node;
    //criados no createWorld; o mundo destrói os dois no destroy()
    private material!: TextureStackPrecalculatedMaterial;
    private generator!: TextureSliceGenerator;
    private gradientTexture!: GPUTexture;
    /**
     * Vai ter os passes TransparentPass, Final pass, com a composição sendo no final
     * pass.
     */
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.slicesPass = new TransparentSlicesRenderPass(this.device, canvasFormat);
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
        this.debugSlicesPass = new DebugSlicesPass(this.device, canvasFormat);
        this.debugOverlayPass = new DebugOverlayPass(this.device, canvas, canvasFormat);
    }
    /**
     * Carrega o volume convertido (metadata.json + slice_NNNN.raw) e monta
     * a cena: câmera olhando a origem + nó-pilha com o TextureSliceGenerator,
     * que cria os nós-fatia como filhos dele no primeiro update. O nó-pilha
     * gira devagar (RotationBehaviour). As proporções físicas do volume vêm
     * do metadata do exame; a cor/opacidade vem da CTF no state ctf do redux.
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
        this.camNode = camNode; //o debug pass orbita esta câmera

        //o CT convertido: textura 3D r16float com HU + o metadata do exame
        const { texture, metadata } = await loadVolumeTexture(this.device, VOLUME_URL);
        // Calcula o gradiente da textura (spacing e maxMagnitude extraídos
        // do metadata pelo helper — as tags DICOM vêm como string)
        this.gradientTexture = createGradientTexture(this.device, texture, gradientParamsFromMetadata(metadata));
        //a CTF vem do store, como o numSlices: se o usuário editou a curva
        //e trocou de mundo, o mundo recriado nasce com a curva editada
        //ordem do construtor: volume (HU) primeiro, gradiente depois
        this.material = new TextureStackPrecalculatedMaterial(
            this.device,
            texture,
            this.gradientTexture,
            store.getState().ctf.points,
        );

        //nó-pilha: a caixa do volume é [-0.5, 0.5]³ no espaço local dele.
        //O scale dá as PROPORÇÕES FÍSICAS do exame (voxel de CT é
        //anisotrópico): PixelSpacing = [entre linhas (y), entre colunas (x)]
        //em mm, SliceThickness em mm — normalizado pro maior eixo = 1.
        const physX = metadata.width * dicomTagNumber(metadata.pixelSpacing, 1);
        const physY = metadata.height * dicomTagNumber(metadata.pixelSpacing, 0);
        const physZ = metadata.numSlices * dicomTagNumber(metadata.sliceThickness);
        const stackNode = new Node();
        stackNode.name = "Volume";
        if (Number.isFinite(physX) && Number.isFinite(physY) && Number.isFinite(physZ) && physZ > 0) {
            const longest = Math.max(physX, physY, physZ);
            stackNode.scale[0] = physX / longest;
            stackNode.scale[1] = physY / longest;
            stackNode.scale[2] = physZ / longest;
        }
        //Em pé, de frente: no CT axial o +z local é pés→cabeça (a ordenação
        //geométrica do conversor é ascendente no normal da fatia) e o +y é
        //anterior→posterior. Rx(-90°) põe a cabeça pra cima e o posterior
        //apontando pra longe da câmera — paciente de frente pro espectador.
        //A RotationBehaviour só mexe no euler Y (ordem yxz: o giro de mundo
        //em Y é aplicado por cima deste X), então o paciente gira em pé.
        stackNode.eulerAngles = new Float32Array([-90, 0, 0]);

        //contagem inicial de fatias vem do store, não de constante: se o
        //usuário mexeu no slider e trocou de mundo, o mundo recriado nasce
        //já com o valor escolhido
        const numSlices = store.getState().textureBasedCT.numSlices;
        this.material.setSliceCount(numSlices); //correção de opacidade já certa no 1º frame
        this.generator = new TextureSliceGenerator(this.device, this.material, numSlices);
        this.generator.node = stackNode;
        stackNode.behaviours.push(this.generator);
        //Cria o behaviour que ouve o alpha scale
        const alphaScaleBehaviour = new SetAlphaScaleBehaviour(this.material);
        stackNode.behaviours.push(alphaScaleBehaviour);
        //rotação lenta pra dar paralaxe sem controle de câmera (por ora)
        const spin = new RotationBehaviour();
        spin.node = stackNode;
        stackNode.behaviours.push(spin);
        //ouve o numSlices do redux e repassa pro generator (mesmo nó) e
        //pro material (correção de opacidade)
        const numSlicesListener = new SetNumSlicesBehaviour(this.material);
        numSlicesListener.node = stackNode;
        stackNode.behaviours.push(numSlicesListener);
        //ouve a tabela de CTF do redux e repassa pro material
        const ctfListener = new SetCtfBehaviour(this.material);
        ctfListener.node = stackNode;
        stackNode.behaviours.push(ctfListener);
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
        //DEBUG: as MESMAS fatias, mas de uma câmera em órbita, pro alvo
        //offscreen próprio do debug pass (não toca no do slices)
        if (this.debugViewEnabled) {
            this.debugSlicesPass.render(encoder, this.rootNode, width, height, this.camNode);
        }
        //composição do offscreen do volume no backbuffer
        this.finalPass.render(encoder, this.slicesPass.colorView);
        //quadzinho de debug POR CIMA do backbuffer (loadOp "load")
        if (this.debugViewEnabled) {
            this.debugOverlayPass.render(encoder, this.debugSlicesPass.colorView);
        }
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (este mundo não usa o registry)
        this.generator.destroy(); //as SliceMesh são do generator
        this.material.destroy(); //textura 3D + params (não registrado)
        this.slicesPass.destroy();
        this.debugSlicesPass.destroy();
        this.debugOverlayPass.destroy();
        this.finalPass.destroy();
    }
}
