//Mundo do TREM (ferrorama) — estágio 0: carrega o rascunho de cena vindo do
//Blender (loco_world.glb), câmera fixa enquadrando a train-locomotive-a e uma
//luz TEMPORÁRIA no alto. Mundo separado de propósito: as tretas do trem não
//encostam no gameVolume (advecção/pressão), que segue como baseline.
//
//Reusa MainRenderPass + PhongColorMaterial (forward Phong, 1 luz) da
//StarshipDemo — nada novo de render aqui.
import { vec3, type Vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { World } from "../world";
import { Node } from "../node";
import { Mesh } from "../mesh";
import { PointLight } from "../Light";
import { loadGltf } from "../gltfLoader";
import { registerMaterial } from "../material";
import { MainRenderPass } from "../StarshipDemo/mainRenderPass";
import { PhongColorMaterial } from "../StarshipDemo/PhongColorMaterial";

export class TrainWorld extends World {
    private mainPass!: MainRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    public meshes: Mesh[] = [];

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.mainPass = new MainRenderPass(this.device, canvasFormat, "clear");
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //Clay default: os "Material" do glb ainda não apontam pra materiais
        //registrados, e sem isso todo renderable cairia no magenta de fallback.
        //Um cinza neutro deixa o rascunho legível; quando os nomes de material
        //do Blender ganharem materiais de verdade, é registrá-los aqui e o
        //loader resolve sozinho — este clay só cobre quem ficou sem.
        const clay = new PhongColorMaterial(this.device, [0.62, 0.60, 0.57, 1], [0.14, 0.14, 0.13], 32);
        registerMaterial("clay", clay);

        const { roots, nodes, meshes } = await loadGltf(this.device, "/models/loco_world.glb");
        this.meshes.push(...meshes);
        roots.forEach(n => this.rootNode.addChild(n));
        nodes.forEach(n => {
            if (n.renderable && !n.renderable.material) {
                n.renderable.material = clay;
            }
        });

        const loco = this.findNode("train-locomotive-a");
        if (!loco) {
            throw new Error('TrainWorld: nó "train-locomotive-a" não encontrado no loco_world.glb.');
        }

        //Enquadramento: a câmera olha pro CENTRO DO AABB da subárvore da
        //locomotiva (o nó pai é só transform; as partes renderáveis são os
        //filhos), a uma distância proporcional à diagonal — funciona onde quer
        //que a loco esteja no circuito, sem número mágico de posição.
        const locoBox = subtreeAABB(loco) ?? subtreeAABB(this.rootNode);
        if (!locoBox) {
            throw new Error("TrainWorld: glb sem nenhum renderable — nada pra enquadrar.");
        }
        const target = vec3.lerp(locoBox.min, locoBox.max, 0.5);
        const locoDiag = vec3.distance(locoBox.min, locoBox.max);
        const camDist = Math.max(2.5 * locoDiag, 5);
        const camDir = vec3.normalize(vec3.create(1, 0.6, 1)); //vista 3/4 de cima
        const cameraNode = new Node();
        cameraNode.name = "Camera";
        vec3.add(target, vec3.scale(camDir, camDist), cameraNode.position);
        this.rootNode.addChild(cameraNode);
        cameraNode.lookAt(target);
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = 0.1;
        camera.far = 2000; //a cena do circuito é grande (~100u); o far do main cortaria
        cameraNode.camera = camera;

        //Luz TEMPORÁRIA no topo da cena. Fica LONGE (≥150u) por causa da
        //calibração herdada: o PhongColorMaterial tem light0Power=250 fixo com
        //atenuação linear (ver nota no gameVolumeWorld) — perto ela estoura
        //tudo pra branco. O offset lateral evita a luz zenital perfeita, que
        //deixaria as faces verticais só com o ambiente.
        const sceneBox = subtreeAABB(this.rootNode)!;
        const sceneCenter = vec3.lerp(sceneBox.min, sceneBox.max, 0.5);
        const light = new Node();
        light.name = "Light0";
        light.light = new PointLight();
        vec3.set(
            sceneCenter[0] + 60,
            sceneBox.max[1] + 150,
            sceneCenter[2] + 60,
            light.position,
        );
        this.rootNode.addChild(light);

        //Padrão dos outros mundos: behaviours (ex.: vindas do glb) enxergam o World.
        this.getAllNodes()
            .filter(n => n.behaviours.length > 0)
            .forEach(n => (n.world = this));
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.mainPass.render(encoder, this.rootNode, width, height);
        this.finalPass.render(encoder, this.mainPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.mainPass.destroy();
        this.finalPass.destroy();
    }
}

/**
 * AABB em coordenadas de mundo da subárvore de `root`: união dos worldAABB de
 * todos os renderables dela. Usa getWorldMatrix() (fresco) porque roda no
 * createWorld, antes do primeiro update popular o cache. `null` se a subárvore
 * não desenha nada.
 */
function subtreeAABB(root: Node): { min: Vec3; max: Vec3 } | null {
    const min = vec3.create(Infinity, Infinity, Infinity);
    const max = vec3.create(-Infinity, -Infinity, -Infinity);
    let found = false;
    const visit = (n: Node): void => {
        if (n.renderable) {
            const box = n.renderable.worldAABB(n.getWorldMatrix());
            for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i], box.min[i]);
                max[i] = Math.max(max[i], box.max[i]);
            }
            found = true;
        }
        n.children.forEach(visit);
    };
    visit(root);
    return found ? { min, max } : null;
}
