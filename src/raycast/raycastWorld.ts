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
import { VolumeRaycastMaterial } from "./volumeRaycastMaterial";
import { VolumeRaycastBehaviour } from "./volumeRaycastBehaviour";
import { OrbitCameraBehaviour } from "./orbitCameraBehaviour";
import { createGradientTexture, gradientParamsFromMetadata } from "../textureStackVolumeRenderCT/gradientCompute";
import { Behaviour } from "../behaviour";

class FramebufferResizerBehaviour extends Behaviour {
    update(_: number): void {
        const scale = store.getState().raycast.framebufferScale;
        const w = this.node.world as RaycastWorld 
        w.resizeFramebuffer(scale);
    }

}

//O CT convertido, o MESMO exame do textureStackVolumeRenderCT.
const VOLUME_URL = "/volumes/abdomen-feet-first";

// Mundo do RAYCASTER de volume (single-pass, proxy-cube).
//
// Infra desta etapa: um nó com o cubo unitário (unitary_cube.glb, [-0.5,0.5]³)
// como proxy da caixa do volume, com o VolumeRaycastMaterial no renderable e o
// VolumeRaycastBehaviour (o cérebro) anexado. O material marcha o raio dentro
// da caixa e compõe o volume usando a MESMA tabela pré-integrada (Engel) e a
// MESMA CTF do mundo CT por fatias — ainda sem gradiente e sem empty-space
// skipping. Só dois passes: o main (que desenha o cubo) e o final (compõe).
export class RaycastWorld extends World{
        private mainPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    private material!: VolumeRaycastMaterial;
    private width!:number;
    private height!: number;
    //gradiente pré-calculado do volume: o WORLD é dono (createGradientTexture
    //devolve a posse ao chamador) e o destrói — o material só a amostra.
    private gradientTexture!: GPUTexture;
    public meshes: Mesh[] = [];
    private camera!:Node;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        //Main pass em "clear" (default): é ele quem limpa o alvo; o volume é
        //composto por cima do fundo pelo blend premultiplied do material.
        this.mainPass = new MeshRenderPass(this.device, canvasFormat);
        //Final pass — compõe o offscreen no backbuffer.
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //Câmera orbital ao redor da mesh do volume (origem). A posição e o
        //lookAt são responsabilidade da OrbitCameraBehaviour, que lê a órbita
        //do redux — aqui só criamos o nó e a projeção.
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

        //Volume 3D (HU r16float) + metadata do exame. A CTF e o alpha vêm do
        //store, como no mundo CT: se o usuário editou e trocou de mundo, o
        //raycaster nasce já com os valores escolhidos.
        const { texture, metadata } = await loadVolumeTexture(this.device, VOLUME_URL);
        //Faixa de HU do exame → redux, pro editor de CTF usar como eixo X.
        store.dispatch(setCtfHuRange(metadata.huMin, metadata.huMax));
        //Gradiente pré-calculado, MESMO compute do mundo CT: uma textura 3D
        //rgba8 gerada uma vez no carregamento (direção nos rgb, magnitude no a).
        //spacing/maxMagnitude saem do metadata do exame pelo helper. A ordem da
        //queue garante que o compute termina antes do 1º sample do raymarch.
        const gradientParams = gradientParamsFromMetadata(metadata);
        this.gradientTexture = createGradientTexture(this.device, texture, gradientParams);
        this.material = new VolumeRaycastMaterial(
            this.device,
            texture,
            this.gradientTexture,
            //o MESMO spacing do gradiente pré-calculado: o modo on-the-fly
            //divide por ele pra a direção do gradiente casar entre os dois modos
            gradientParams.spacing,
            store.getState().ctf.points,
            store.getState().textureBasedCT.alphaScale,
        );

        //O proxy: o cubo unitário [-0.5,0.5]³ = a caixa do volume.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        this.meshes.push(...cube.meshes);
        cube.roots.forEach(r => this.rootNode.addChild(r));
        const volumeNode = cube.nodes.find(n => n.renderable);
        if (!volumeNode || !volumeNode.renderable) {
            throw new Error("RaycastWorld: unitary_cube.glb sem renderable.");
        }
        volumeNode.name = "Volume";
        volumeNode.renderable.material = this.material;

        //Proporções físicas do exame (voxel de CT é anisotrópico), normalizadas
        //pro maior eixo = 1 — mesmo cálculo do mundo CT.
        const physX = metadata.width * dicomTagNumber(metadata.pixelSpacing, 1);
        const physY = metadata.height * dicomTagNumber(metadata.pixelSpacing, 0);
        const physZ = metadata.numSlices * dicomTagNumber(metadata.sliceThickness);
        if (Number.isFinite(physX) && Number.isFinite(physY) && Number.isFinite(physZ) && physZ > 0) {
            const longest = Math.max(physX, physY, physZ);
            volumeNode.scale[0] = physX / longest;
            volumeNode.scale[1] = physY / longest;
            volumeNode.scale[2] = physZ / longest;
        }
        //Em pé, de frente: Rx(-90°) põe a cabeça pra cima (mesmo do mundo CT).
        volumeNode.eulerAngles = new Float32Array([-90, 0, 0]);

        //O cérebro: sincroniza CTF + alphaScale do redux com o material.
        const brain = new VolumeRaycastBehaviour(this.material);
        brain.node = volumeNode;
        volumeNode.behaviours.push(brain);

        this.root.addBehaviour(new FramebufferResizerBehaviour());
        this.root.world = this;
    }

    resizeFramebuffer(factor:number) {
        this.width = this.canvas.width * factor;
        this.height = this.canvas.height * factor;
        this.camera.camera!.aspect = this.width/this.height;
    }
    
    render(encoder: GPUCommandEncoder): void {
        //Resize primeiro, pra todos os passes verem o mesmo tamanho.
        this.finalPass.resizeIfNeeded();
        const width = this.width;
        const height = this.height;
        //Main pass — limpa o alvo e desenha o cubo (o material faz o raymarch).
        this.mainPass.render(encoder, this.rootNode, width, height,
            {r:0, g:0, b:0, a:0}
        );
        //Composição do offscreen no backbuffer.
        this.finalPass.render(encoder, this.mainPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (nenhum aqui)
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.material.destroy(); //textura 3D + tabela pré-integrada + params
        this.gradientTexture.destroy(); //do world (o material só a amostra)
        this.mainPass.destroy();
        this.finalPass.destroy();
    }
}
