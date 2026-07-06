import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { Node } from "../node";
import { RotationBehaviour } from "../rotation_behaviour";
import { World } from "../world";
import { loadVolumeTexture } from "../volumeLoader";
import { dicomTagNumber } from "../volume-types";
import { TextureSliceGenerator } from "../textureStackVolumeRender/textureSliceGenerator";
import { SetNumSlicesBehaviour } from "./setNumSlicesBehaviour";
import { store } from "../redux/store";
import { TextureStackTransparentMaterial } from "../textureStackVolumeRender/textureStackTransparentMaterial";
import { TransparentSlicesRenderPass } from "../textureStackVolumeRender/TransparentSlicesRenderPass";

const VOLUME_URL = "/volumes/abdomen-feet-first";

/**
 * O VR por fatias com um CT DE VERDADE: a saída do dicom_converter.py
 * servida de public/volumes/. As peças da técnica (pass, SliceMesh,
 * generator, material) moram em ../textureStackVolumeRender/ e são as
 * mesmas do mundo sintético — a diferença é a origem da textura 3D e que
 * aqui o window/level sugerido e as proporções físicas vêm do metadata.
 */
export class TextureStackVolumeRendererCT extends World {
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
     * Carrega o volume convertido (metadata.json + slice_NNNN.raw) e monta
     * a cena: câmera olhando a origem + nó-pilha com o TextureSliceGenerator,
     * que cria os nós-fatia como filhos dele no primeiro update. O nó-pilha
     * gira devagar (RotationBehaviour). O window/level inicial e as
     * proporções físicas do volume vêm do metadata do exame.
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

        //o CT convertido: textura 3D r16float com HU + o metadata do exame
        const { texture, metadata } = await loadVolumeTexture(this.device, VOLUME_URL);

        //window/level sugerido pelo próprio exame (tags Window Center/Width;
        //multivalor pega a primeira janela). NaN → fallback tecido mole.
        let windowCenter = dicomTagNumber(metadata.windowCenter);
        let windowWidth = dicomTagNumber(metadata.windowWidth);
        if (!Number.isFinite(windowCenter)) windowCenter = 40;
        if (!Number.isFinite(windowWidth) || windowWidth <= 0) windowWidth = 400;
        this.material = new TextureStackTransparentMaterial(
            this.device,
            texture,
            windowCenter,
            windowWidth,
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
        this.generator = new TextureSliceGenerator(this.device, this.material, numSlices);
        this.generator.node = stackNode;
        stackNode.behaviours.push(this.generator);
        //rotação lenta pra dar paralaxe sem controle de câmera (por ora)
        const spin = new RotationBehaviour();
        spin.node = stackNode;
        stackNode.behaviours.push(spin);
        //ouve o numSlices do redux e repassa pro generator (mesmo nó)
        const numSlicesListener = new SetNumSlicesBehaviour();
        numSlicesListener.node = stackNode;
        stackNode.behaviours.push(numSlicesListener);
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
