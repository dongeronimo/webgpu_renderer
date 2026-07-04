
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { HelloReactBehaviour } from "./helloReactBehaviour";
import { loadGltf } from "../gltfLoader";
import { registerMaterial, UnshadedOpaque, UnshadedTextured } from "../material";
import { Mesh } from "../mesh";
import { MeshRenderPass } from "../meshPass";
import { RenderPassBit } from "../renderable";
import { SkyboxRenderPass } from "../skyboxPass";
import { World } from "../world";
import { loadCubemapTexture, loadTexture } from "../textureLoader";

export class SolarSystem extends World {
    public meshes:Mesh[] = [];

    //Criados no createRenderPasses (o main chama antes do createWorld);
    //o ! é esse contrato de ciclo de vida.
    private skyboxPass!: SkyboxRenderPass;
    private meshPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
        this.skyboxPass = new SkyboxRenderPass(this.device, canvasFormat);
        //"load": quem limpa o alvo neste mundo é o skybox pass, que roda antes
        this.meshPass = new MeshRenderPass(this.device, canvasFormat, "load");
    }

    render(encoder: GPUCommandEncoder): void {
        //Resize primeiro, pra todos os passes verem o mesmo tamanho
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        //O alvo é do mesh pass, mas o skybox desenha nele antes — garante
        //que ele exista no tamanho certo
        this.meshPass.ensureTargets(width, height);
        //Fundo: clear + cubemap
        this.skyboxPass.render(encoder, this.rootNode, this.meshPass.colorView, width, height);
        //Cena → por cima do fundo (loadOp "load")
        this.meshPass.render(encoder, this.rootNode, width, height);
        //Composição do offscreen no backbuffer
        this.finalPass.render(encoder, this.meshPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (donos das texturas)
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.skyboxPass.destroy();
        this.meshPass.destroy();
        this.finalPass.destroy();
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        const terraTex = await loadTexture(this.device, "/textures/earth.jpg");
        const moonTex = await loadTexture(this.device, "/textures/moon.jpg");
        registerMaterial("sun", new UnshadedOpaque(this.device, [1.0, 0.8,0,1]));
        registerMaterial("terra", new UnshadedTextured(this.device, terraTex));
        registerMaterial("moon", new UnshadedTextured(this.device, moonTex));
        const {roots, nodes, meshes} = await loadGltf(this.device, "/models/solar_system.glb");
        //guarda as meshes: o mundo é o dono delas, o destroy() as libera
        this.meshes = meshes;
        //só uma root
        roots.forEach(n=>{
            this.rootNode.addChild(n);
        });

        //O cubo do skybox: entra na árvore do mundo como filho da MESMA root
        //(ROOT continua sendo a única raiz), mas com o passMask trocado —
        //sai do main pass, entra só no skybox pass, que o acha na árvore.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        this.meshes.push(...cube.meshes);
        cube.roots.forEach(n=>{
            this.rootNode.addChild(n);
        });
        cube.nodes.forEach(n=>{
            if (n.renderable) {
                n.renderable.passMask = RenderPassBit.Skybox;
            }
        });
        this.skyboxPass.setCubemap(
            await loadCubemapTexture(this.device, "/textures/cubemap_galaxy.png"),
        );
        //demonstração do fluxo UI→engine: behaviour pendurada em código
        //(o outro jeito seria a custom property do Blender + registry)
        const terra = nodes.find(n=>n.name == "Terra");
        if (terra) {
            const hello = new HelloReactBehaviour();
            hello.node = terra;
            terra.behaviours.push(hello);
        } else {
            console.warn("SolarSystem: nó 'Terra' não encontrado — HelloReactBehaviour não anexada.");
        }

        //procura o nó da camera, pega o primeiro que achar
        const cams = nodes.filter(n=>n.name == "Camera");
        cams[0].camera = new Camera();
        cams[0].camera.aspect = perspective.aspect;
        cams[0].camera.near = perspective.near;
        cams[0].camera.far = perspective.far;
        cams[0].camera.fovY = perspective.fovy;
    }

}
