//Mundo do GAUNTLET — client da vertical multiplayer (server Spring Boot em
//gauntlet_server/; spec em src/instructions/multiplayer.md). Estágio 0: só o
//cubo unitário na tela, câmera fixa e luz no alto — o esqueleto onde a parte
//de rede (WebSocket, snapshots, interpolação) vai ser construída. Mundo
//separado de propósito: experimento novo não mexe nos mundos fechados.
//
//Reusa MainRenderPass + PhongColorMaterial (forward Phong, 1 luz) da
//StarshipDemo — nada novo de render aqui, igual ao TrainWorld.
import { vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { World } from "../world";
import { Node } from "../node";
import { Mesh } from "../mesh";
import { Renderable } from "../renderable";
import { Light } from "../Light";
import { loadGltf } from "../gltfLoader";
import { registerMaterial } from "../material";
import { MainRenderPass } from "../StarshipDemo/mainRenderPass";
import { PhongColorMaterial } from "../StarshipDemo/PhongColorMaterial";
import { JoinRequest } from "./dto/JoinMessage";

export class GauntletWorld extends World {
    private mainPass!: MainRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    public meshes: Mesh[] = [];
    private wsSignaling!: WebSocket;
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.mainPass = new MainRenderPass(this.device, canvasFormat, "clear");
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        const clay = new PhongColorMaterial(this.device, [0.62, 0.60, 0.57, 1], [0.14, 0.14, 0.13], 32);
        registerMaterial("clay", clay);

        //O cubo unitário ([-0.5,0.5]³) — mesmo asset do gameVolume.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        this.meshes.push(...cube.meshes);
        const cubeMesh = cube.meshes[0];
        if (!cubeMesh) {
            throw new Error("GauntletWorld: unitary_cube.glb sem mesh.");
        }
        const cubeNode = new Node();
        cubeNode.name = "Cube";
        const renderable = new Renderable(cubeMesh);
        renderable.material = clay;
        cubeNode.renderable = renderable;
        this.rootNode.addChild(cubeNode);

        //Câmera fixa em vista 3/4, olhando pro cubo na origem. Distância na mão
        //mesmo: a cena é UM cubo unitário, não precisa do enquadramento por AABB
        //do TrainWorld.
        const cameraNode = new Node();
        cameraNode.name = "Camera";
        vec3.set(2.2, 1.6, 2.2, cameraNode.position);
        this.rootNode.addChild(cameraNode);
        cameraNode.lookAt(vec3.create(0, 0, 0));
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        camera.far = perspective.far;
        cameraNode.camera = camera;

        //Luz no alto e LONGE (≥150u), pela calibração herdada: o
        //PhongColorMaterial tem light0Power=250 fixo com atenuação linear —
        //perto ela estoura tudo pra branco. Offset lateral pra faces verticais
        //não ficarem só no ambiente.
        const light = new Node();
        light.name = "Light0";
        light.light = new Light();
        vec3.set(60, 150, 60, light.position);
        this.rootNode.addChild(light);

        //Padrão dos outros mundos: behaviours enxergam o World.
        this.getAllNodes()
            .filter(n => n.behaviours.length > 0)
            .forEach(n => (n.world = this));
    
        //Teste do spring security
        await fetch("/login", {method:"POST", 
            body: new URLSearchParams({
                username:"Alice", password:"foobar"
            }) });
        this.wsSignaling = new WebSocket(`ws://${location.host}/ws/signaling`);
        this.wsSignaling.onopen = ()=>this.wsSignaling.send(JSON.stringify(JoinRequest));
        this.wsSignaling.onmessage = e=>console.log(e.data);
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
        this.wsSignaling.close();
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.mainPass.destroy();
        this.finalPass.destroy();
    }
}
