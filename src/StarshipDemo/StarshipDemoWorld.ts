
import { vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
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
import { DoubleSidedPhongMaterial } from "./DoubleSidedPhongMaterial";
import { registerBehaviour } from "../behaviour";
import { MoveShipBehaviour } from "./MoveShipBehaviour";
import { ShipLifecycleBehaviour } from "./ShipLifecycleBehaviour";
import { Prefab } from "../prefab";
import { ShipSpawnerBehaviour } from "./ShipSpawnwerBehaviour";
// Nesse mundo nós testamos a instanciação de prefabs e expandimos mais um pouco as capacidades do sistema.
// Na ordem cronológica esse mundo foi criado depois do TextureRenderer.
//
// Nós temos uma nave que voa pelo espaço e dispara tiros. os tiros são prefabs instanciados.
export class StarshipDemoWorld extends World {
    private skyboxPass!: SkyboxRenderPass;
    /** Template da nave. Instâncias saem daqui via spawnStarship(). */
    private starshipPrefab!: Prefab;
    private light0!: Node;
    private mainPass!: MainRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    public meshes:Mesh[] = [];

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        //Skybox pass — roda primeiro e é ele quem limpa o alvo
        this.skyboxPass = new SkyboxRenderPass(this.device, canvasFormat);
        //Main pass em "load": o skybox já pintou o fundo antes deste
        this.mainPass = new MainRenderPass(this.device, canvasFormat, "load");
        //Final pass — compõe o offscreen no backbuffer
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //cria as behaviours
        registerBehaviour("MoveShip", MoveShipBehaviour);
        registerBehaviour("ShipLifecycle", ShipLifecycleBehaviour);
        // Cria os materiais da nave (os nomes batem com os do glb: Metal/Glow/Composite/Carbon)
        const metalMaterial = new PhongColorMaterial(this.device, [0.11, 0.11, 0.12 ,1], 
            [0.011, 0.011, 0.012 ], 128);
        const glowMaterial = new DoubleSidedPhongMaterial(this.device, 
            [0.215, 0.450, 1, 1], 
            [0, 0, 1], 8);
        const compositeMaterial = new PhongColorMaterial(this.device, [0.47, 0.47, 0.47, 16], 
            [0.047, 0.047, 0.047], 32);
        const carbonMaterial = new PhongColorMaterial(this.device, [0.25, 0.25, 0.25, 1], 
            [0.025, 0.025, 0.025], 8);
        registerMaterial("Metal", metalMaterial);
        registerMaterial("Glow", glowMaterial);
        registerMaterial("Composite", compositeMaterial);
        registerMaterial("Carbon", carbonMaterial);
        //TODO PREFAB: Criar o material do tiro
        // Carrega a nave e a transforma num PREFAB, em vez de pôr direto na
        // cena: a nave é feita pra ser spawnada (ShipLifecycle randomiza o
        // spawn e a destrói após uns segundos; MoveShip faz voar). As Mesh
        // continuam sendo do World (this.meshes as destrói no destroy()); o
        // template do prefab fica destacado, fora da árvore viva.
        const {nodes, meshes} = await loadGltf(this.device, '/models/starship.glb');
        this.meshes.push(...meshes);
        const shipRoot = nodes.filter(node=>node.name === "ShipRoot")[0];
        if (!shipRoot) {
            throw new Error("StarshipDemoWorld: nó 'ShipRoot' não encontrado no starship.glb.");
        }
        shipRoot.setParent(null); //destaca o template do resto do glb
        this.starshipPrefab = Prefab.fromTemplate(shipRoot, "Starship");
        //TODO PREFAB: um spawner que chame spawnStarship() periodicamente.
        //Por ora, spawna uma nave pra provar o caminho de prefab.
        this.spawnStarship();
        //TODO PREFAB: Criar o prefab do tiro
        //TODO PREFAB: Criar o ambiente
        //- Cria o skybox
        await this.createSkybox("/textures/cubemap_galaxy.png");
        //- Cria a luz. O glb não traz luz, então criamos uma key light no alto,
        //  de lado. Ainda não há componente de intensidade — a "potência" mora
        //  no shader do PhongColorMaterial por enquanto.
        this.light0 = new Node();
        this.light0.name = "Light0";
        vec3.set(60, 100, 60, this.light0.position);
        this.light0.light = new Light();
        this.rootNode.addChild(this.light0);
        //- Cria a câmera. O glb também não traz câmera, então criamos uma que
        //  enquadra a nave inteira (bbox ~30x18x60, centro ~ (0, 9, 1)) numa
        //  vista 3/4 de cima. Como a cena é grande, o far do main (100) cortaria
        //  a nave — este mundo usa o seu próprio.
        const cameraNode = new Node();
        cameraNode.name = "Camera";
        vec3.set(60, 45, 90, cameraNode.position);
        this.rootNode.addChild(cameraNode);
        cameraNode.lookAt(vec3.create(0, 9, 1));
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        //near tem que ser MENOR que a meia-aresta do cubo do skybox (~0.5): ele
        //fica preso na câmera, e um near maior o clipa inteiro por near-plane.
        camera.near = 0.1;
        camera.far = 2000;  //a nave fica a ~113 da câmera; o far:100 do main cortaria
        cameraNode.camera = camera;
        //garante que todos tem referência ao world
        this.getAllNodes()
          .filter(n=>n.behaviours.length>0)
          .forEach(n=>n.world = this);
        //adiciona o spawner ao root (addBehaviour seta o .node; push cru não):
        this.root.addBehaviour(new ShipSpawnerBehaviour());
    }

    /**
     * Instancia o prefab da nave e a coloca na cena. As behaviours da
     * instância cuidam do resto (ShipLifecycle randomiza a posição e agenda a
     * autodestruição; MoveShip faz voar). Devolve a raiz da instância.
     *
     * Passa `this` ao instantiate pra que os nós da cópia já nasçam com
     * `.world` setado ANTES do start() — a ShipLifecycle depende disso pra
     * chamar `this.node.world!.destroyNode(...)`.
     */
    public spawnStarship(): Node {
        const ship = this.starshipPrefab.instantiate(this);
        this.rootNode.addChild(ship);
        return ship;
    }

    render(encoder: GPUCommandEncoder): void {
        //Resize primeiro, pra todos os passes verem o mesmo tamanho
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        //O alvo é do main pass, mas o skybox desenha nele antes — garante
        //que ele exista no tamanho certo
        this.mainPass.ensureTargets(width, height);
        //Fundo: clear + cubemap
        this.skyboxPass.render(encoder, this.rootNode, this.mainPass.colorView, width, height);
        //Nave → por cima do fundo (loadOp "load")
        this.mainPass.render(encoder, this.rootNode, width, height);
        //Composição do offscreen no backbuffer
        this.finalPass.render(encoder, this.mainPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.skyboxPass.destroy();
        this.mainPass.destroy();
        this.finalPass.destroy();
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
