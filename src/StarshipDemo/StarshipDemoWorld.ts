
import { FinalRenderPass } from "../finalPass";
import { SkyboxRenderPass } from "../skyboxPass";
import { World } from "../world";
import { MainRenderPass } from "./mainRenderPass";
import { loadGltf } from "../gltfLoader";
import { Mesh } from "../mesh";
import { RenderPassBit } from "../renderable";
import { loadCubemapTexture } from "../textureLoader";
import { Node } from "../node";
import { PhongColorMaterial } from "./PhongColorMaterial";
import { registerMaterial } from "../material";
import { Light } from "../Light";
// Nesse mundo nós testamos a instanciação de prefabs e expandimos mais um pouco as capacidades do sistema.
// Na ordem cronológica esse mundo foi criado depois do TextureRenderer.
//
// Nós temos uma nave que voa pelo espaço e dispara tiros. os tiros são prefabs instanciados.
export class StarshipDemoWorld extends World {
    private skyboxPass!: SkyboxRenderPass;
    private starship!: Node;
    private light0!: Node;
    private mainPass!: MainRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    public meshes:Mesh[] = [];
    
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        //Skybox pass
        this.skyboxPass = new SkyboxRenderPass(this.device, canvasFormat);
        //Main pass 
        this.mainPass = new MainRenderPass(this.device, canvasFormat);
        //Final pass
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);

    }
    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        // Cria os materiais da nave
        const metalMaterial = new PhongColorMaterial(this.device, [0.11, 0.11, 0.12 ,1], [0.011, 0.011, 0.012 ], 128);
        const glowMaterial = new PhongColorMaterial(this.device, [0.215, 0.450, 1, 1], [0.215, 0.450, 1], 1);
        const compositeMaterial = new PhongColorMaterial(this.device, [0.47, 0.47, 0.47, 1], [0.047, 0.047, 0.047], 32);
        const carbonMaterial = new PhongColorMaterial(this.device, [0.25, 0.25, 0.25, 1], [0.025, 0.025, 0.025], 8);
        registerMaterial("Metal", metalMaterial);
        registerMaterial("Glow", glowMaterial);
        registerMaterial("Composite", compositeMaterial);
        registerMaterial("Carbon", carbonMaterial);
        //TODO PREFAB: Criar o material do tiro
        // Carrega a nave
        const {roots, nodes, meshes} = await loadGltf(this.device, '/models/starship.glb');
        this.meshes.push(...meshes);
        roots.forEach(n=>{this.rootNode.addChild(n)});
        this.starship = nodes.filter(node=>node.name === "ShipRoot")[0];
        //TODO PREFAB: Criar o prefab do tiro
        //TODO PREFAB: Criar o ambiente
        //- Cria o skybox
        await this.createSkybox("/textures/cubemap_galaxy.png");
        //- Cria a luz
        this.light0 = new Node();
        this.light0.position[0] = 10; this.light0.position[1] = 10; this.light0.position[10];
        this.light0.light = new Light();
        this.root.addChild(this.light0); 
    }

    render(encoder: GPUCommandEncoder): void {
        throw new Error("Method not implemented.");
    }

    /**
     * serve pra tirar esse bloco de código do createWorld e deixar o método menos poluído.
     * @param skyboxFile o path pro arquivo, que deve estar na ./public.
     */
    private async createSkybox(skyboxFile:string){
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
            await loadCubemapTexture(this.device, skyboxFile),
        );
    }
    
}