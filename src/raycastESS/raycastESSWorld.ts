import { vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { MeshRenderPass } from "../meshPass";
import { World } from "../world";
import { Node } from "../node";
import { Mesh } from "../mesh";
import { loadGltf } from "../gltfLoader";
import { loadVolumeTexture } from "../volumeLoader";
import { dicomTagNumber } from "../volume-types";
import { store } from "../redux/store";
import { setCtfHuRange } from "../redux/actions";
import { VolumeRaycastESSMaterial } from "./volumeRaycastESSMaterial";
import { VolumeRaycastESSBehaviour } from "./volumeRaycastESSBehaviour";
import { OrbitCameraBehaviour } from "../raycast/orbitCameraBehaviour";
import { createGradientTexture, gradientParamsFromMetadata } from "../textureStackVolumeRenderCT/gradientCompute";
import { Behaviour } from "../behaviour";
import { loadChunkOccupancy, ctfVisibleMask, computeSkipMap } from "./chunkOccupancy";
import { DebugChunksPass } from "./debugChunksPass";
import { DebugChunksOverlayPass } from "./debugChunksOverlayPass";

//Mesma behaviour de resize do baseline: lê o framebufferScale do redux e
//redimensiona o alvo do main pass (menos fragmentos = menos raios).
class FramebufferResizerBehaviour extends Behaviour {
    update(_: number): void {
        const scale = store.getState().raycast.framebufferScale;
        const w = this.node.world as RaycastESSWorld;
        w.resizeFramebuffer(scale);
    }
}

//O MESMO exame do raycaster baseline.
const VOLUME_URL = "/volumes/abdomen-feet-first";

//O PiP de debug é um quadzinho no canto (~0.28 da tela): renderá-lo no tamanho
//CHEIO do canvas é desperdício. ~0.4 cobre o display com folga de supersampling
//e corta o custo do pass em ~6x. Escala os DOIS eixos igual → mantém o aspecto
//(o overlay não estica).
const DEBUG_PIP_RES_SCALE = 0.4;

// Mundo do RAYCASTER com EMPTY-SPACE SKIPPING — clone NÃO-DESTRUTIVO do
// RaycastWorld (baseline intacto pra A/B de qualidade/velocidade no gpuTimer).
// Idêntico ao baseline (proxy-cube, CTF pré-integrada, gradiente, framebuffer
// scaling), MAIS: carrega os histogramas de chunk (chunk_histograms.bin),
// reduz a uma ocupação estática, e mantém um skip-map (recalculado quando a CTF
// muda) que faz o raymarch pular chunks sem nada visível pra CTF atual.
export class RaycastESSWorld extends World {
    private mainPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    private material!: VolumeRaycastESSMaterial;
    private width!: number;
    private height!: number;
    //gradiente pré-calculado: o WORLD é dono e o destrói (o material só amostra)
    private gradientTexture!: GPUTexture;
    public meshes: Mesh[] = [];
    private camera!: Node;
    //debug PiP (canto inferior): os cubos dos chunks mantidos pra CTF atual
    private debugChunksPass!: DebugChunksPass;
    private debugOverlayPass!: DebugChunksOverlayPass;
    //refs pro debug pass: o nó do volume (model matrix + mesh do cubo) e a grade
    private volumeNode!: Node;
    private numChunks!: [number, number, number];
    private chunkCell!: [number, number, number];

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        this.mainPass = new MeshRenderPass(this.device, canvasFormat);
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
        //passes de DEBUG do ESS: os cubos num offscreen + o overlay no canto
        this.debugChunksPass = new DebugChunksPass(this.device, canvasFormat);
        this.debugOverlayPass = new DebugChunksOverlayPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //Câmera orbital (mesma OrbitCameraBehaviour do baseline, lê a órbita do
        //redux — a UI de captura de mouse é do App).
        this.camera = new Node();
        this.camera.name = "Camera";
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        camera.far = perspective.far;
        this.camera.camera = camera;
        this.rootNode.addChild(this.camera);
        this.camera.addBehaviour(new OrbitCameraBehaviour(vec3.create(0, 0, 0)));

        //Volume 3D (HU r16float) + metadata do exame.
        const { texture, metadata } = await loadVolumeTexture(this.device, VOLUME_URL);
        //Faixa de HU do exame → redux, pro editor de CTF usar como eixo X.
        store.dispatch(setCtfHuRange(metadata.huMin, metadata.huMax));
        //Gradiente pré-calculado (mesmo compute do mundo CT).
        const gradientParams = gradientParamsFromMetadata(metadata);
        this.gradientTexture = createGradientTexture(this.device, texture, gradientParams);

        //ESS: carrega os histogramas de chunk e os reduz à ocupação estática
        //(1 u32/chunk). É intrínseco do volume — carregado uma vez aqui.
        const occupancy = await loadChunkOccupancy(VOLUME_URL, metadata);

        const initialCtf = store.getState().ctf.points;
        this.material = new VolumeRaycastESSMaterial(
            this.device,
            texture,
            this.gradientTexture,
            gradientParams.spacing,
            initialCtf,
            {
                numChunksX: metadata.numChunksX,
                numChunksY: metadata.numChunksY,
                numChunksZ: metadata.numChunksZ,
                totalChunks: metadata.totalChunks,
                chunkSize: metadata.chunkSize,
            },
            store.getState().textureBasedCT.alphaScale,
            store.getState().raycast.gradientEnabled,
            store.getState().raycast.gradientMode === "on-the-fly" ? 1 : 0,
            store.getState().raycast.essEnabled,
        );
        //skip-map INICIAL: o world calcula a partir da CTF corrente (a behaviour
        //só recalcula em MUDANÇAS, então o 1º frame já precisa estar certo).
        const initialMask = ctfVisibleMask(
            initialCtf, metadata.histogramBins, metadata.histogramMin, metadata.histogramMax,
        );
        this.material.setSkipMap(computeSkipMap(occupancy, initialMask));

        //O proxy: o cubo unitário [-0.5,0.5]³ = a caixa do volume.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        this.meshes.push(...cube.meshes);
        cube.roots.forEach(r => this.rootNode.addChild(r));
        const volumeNode = cube.nodes.find(n => n.renderable);
        if (!volumeNode || !volumeNode.renderable) {
            throw new Error("RaycastESSWorld: unitary_cube.glb sem renderable.");
        }
        volumeNode.name = "Volume";
        volumeNode.renderable.material = this.material;
        //refs pro debug pass: model matrix + mesh do cubo saem daqui; a grade e o
        //tamanho do chunk em uvw (chunkSize/dims por eixo) do metadata.
        this.volumeNode = volumeNode;
        this.numChunks = [metadata.numChunksX, metadata.numChunksY, metadata.numChunksZ];
        this.chunkCell = [
            metadata.chunkSize / metadata.width,
            metadata.chunkSize / metadata.height,
            metadata.chunkSize / metadata.numSlices,
        ];

        //Proporções físicas do exame (voxel de CT é anisotrópico), normalizadas
        //pro maior eixo = 1 — mesmo cálculo do baseline.
        const physX = metadata.width * dicomTagNumber(metadata.pixelSpacing, 1);
        const physY = metadata.height * dicomTagNumber(metadata.pixelSpacing, 0);
        const physZ = metadata.numSlices * dicomTagNumber(metadata.sliceThickness);
        if (Number.isFinite(physX) && Number.isFinite(physY) && Number.isFinite(physZ) && physZ > 0) {
            const longest = Math.max(physX, physY, physZ);
            volumeNode.scale[0] = physX / longest;
            volumeNode.scale[1] = physY / longest;
            volumeNode.scale[2] = physZ / longest;
        }
        //Em pé, de frente: Rx(-90°) põe a cabeça pra cima (mesmo do baseline).
        volumeNode.eulerAngles = new Float32Array([-90, 0, 0]);

        //O cérebro: CTF + alpha + gradiente + skip-map + ESS on/off.
        const brain = new VolumeRaycastESSBehaviour(
            this.material,
            occupancy,
            metadata.histogramBins,
            metadata.histogramMin,
            metadata.histogramMax,
        );
        brain.node = volumeNode;
        volumeNode.behaviours.push(brain);

        this.root.addBehaviour(new FramebufferResizerBehaviour());
    }

    resizeFramebuffer(factor: number) {
        //Math.floor: factor fracionário não pode virar tamanho de textura
        //fracionário (o baseline ainda não fazia isso — aqui já entra certo).
        this.width = Math.max(1, Math.floor(this.canvas.width * factor));
        this.height = Math.max(1, Math.floor(this.canvas.height * factor));
        this.camera.camera!.aspect = this.width / this.height;
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.width;
        const height = this.height;
        this.mainPass.render(encoder, this.rootNode, width, height);
        this.finalPass.render(encoder, this.mainPass.colorView);

        //PiP de debug: cubos dos chunks mantidos, no canto inferior direito.
        //Gateado pelo redux (lido por-frame de propósito: gateia PASSES, não é
        //estado de nó). Renderiza no tamanho CHEIO do canvas (não o escalado do
        //framebufferScale) pra o quadzinho ficar nítido.
        if (store.getState().raycast.essDebugView) {
            this.debugChunksPass.render(
                encoder,
                this.camera,
                this.volumeNode.worldMatrix,
                this.volumeNode.renderable!.mesh,
                this.material.skipMapBuffer,
                this.numChunks,
                this.chunkCell,
                Math.max(1, Math.round(this.canvas.width * DEBUG_PIP_RES_SCALE)),
                Math.max(1, Math.round(this.canvas.height * DEBUG_PIP_RES_SCALE)),
            );
            this.debugOverlayPass.render(encoder, this.debugChunksPass.colorView);
        }
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (nenhum aqui)
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.material.destroy(); //volume + preint + params + skip-map
        this.gradientTexture.destroy(); //do world (o material só a amostra)
        this.mainPass.destroy();
        this.finalPass.destroy();
        this.debugChunksPass.destroy();
        this.debugOverlayPass.destroy();
    }
}
