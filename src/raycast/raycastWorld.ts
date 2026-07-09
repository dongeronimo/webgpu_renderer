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
import { VolumeRaycastMaterial } from "./volumeRaycastMaterial";
import { VolumeRaycastBehaviour } from "./volumeRaycastBehaviour";
import { OrbitCameraBehaviour } from "./orbitCameraBehaviour";

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
export class RaycastWorld extends World {
    private mainPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    private material!: VolumeRaycastMaterial;
    public meshes: Mesh[] = [];

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
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
        const camNode = new Node();
        camNode.name = "Camera";
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        camera.far = perspective.far;
        camNode.camera = camera;
        this.rootNode.addChild(camNode);
        camNode.addBehaviour(new OrbitCameraBehaviour(vec3.create(0, 0, 0)));

        //Volume 3D (HU r16float) + metadata do exame. A CTF e o alpha vêm do
        //store, como no mundo CT: se o usuário editou e trocou de mundo, o
        //raycaster nasce já com os valores escolhidos.
        const { texture, metadata } = await loadVolumeTexture(this.device, VOLUME_URL);
        this.material = new VolumeRaycastMaterial(
            this.device,
            texture,
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
    }

    render(encoder: GPUCommandEncoder): void {
        //Resize primeiro, pra todos os passes verem o mesmo tamanho.
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        //Main pass — limpa o alvo e desenha o cubo (o material faz o raymarch).
        this.mainPass.render(encoder, this.rootNode, width, height);
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
        this.mainPass.destroy();
        this.finalPass.destroy();
    }
}
