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
import { Renderable, RenderPassBit } from "../renderable";
import { Light } from "../Light";
import { loadGltf } from "../gltfLoader";
import { registerMaterial } from "../material";
import { MainRenderPass } from "../StarshipDemo/mainRenderPass";
import { PhongColorMaterial } from "../StarshipDemo/PhongColorMaterial";
import GauntletNetworkBehaviour from "./GauntletNetwork";
import { TexturedOpaquePhong } from "./materials/TexturedOpaquePhong";
import { loadTexture } from "../textureLoader";
import { Prefab } from "../prefab";
import PrefabFabricator from "../PrefabFabricator";
import { SkinnedPhongMaterial } from "../skinning/SkinnedPhongMaterial";
import { Material } from "../material";
import { SkinnedRenderPass } from "../skinning/skinnedRenderPass";

export class GauntletWorld extends World implements PrefabFabricator {
    private mainPass!: MainRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    public meshes: Mesh[] = [];
    public prefabs: Map<string, Prefab> = new Map(); 
    private skinnedPass!: SkinnedRenderPass;
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.skinnedPass = new SkinnedRenderPass(this.device, canvasFormat, "clear");
        //"clear": aqui é o PRIMEIRO pass a tocar o alvo — desenha a dungeon,
        //e o skinnedPass entra DEPOIS por cima via renderOnto (color+depth
        //"load"), senão o chão (opaco, cobre a tela inteira na câmera
        //top-down) sobrescreveria os avatares. depthStoreOp "store" (não o
        //default "discard"): sem isso o depth do mainPass some antes do
        //skinnedPass poder testar contra ele — o teste falha pra tudo e o
        //avatar não desenha nenhum pixel, mesmo desenhado com sucesso.
        this.mainPass = new MainRenderPass(this.device, canvasFormat, "clear", "store");
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        const clay = new PhongColorMaterial(this.device, [0.62, 0.60, 0.57, 1], [0.14, 0.14, 0.13], 32);
        const blackRock = new TexturedOpaquePhong(
            this.device, {
                diffuseColor: [1,1,1,1],
                diffuseTexture: await loadTexture(this.device, "/textures/black_rock.png"),
                shininess:32
            }
        )
        registerMaterial("clay", clay);
        registerMaterial("blackRock", blackRock);
        //teste: específico do xbot, no futuor vai ter que ser trocado
        const player1BodyMaterial = new SkinnedPhongMaterial(this.device, [0.72, 0.73, 0.75, 1], [0.06, 0.06, 0.07], 48);
        const player1JointsMaterial = new SkinnedPhongMaterial(this.device, [0.90, 0.45, 0.10, 1], [0.08, 0.04, 0.01], 24);
        const player2BodyMaterial = new SkinnedPhongMaterial(this.device, [0.20, 0.20, 0.50, 1], [0.06, 0.06, 0.07], 48);
        const player2JointsMaterial = new SkinnedPhongMaterial(this.device, [0.10, 0.45, 0.90, 1], [0.08, 0.04, 0.01], 24);
        registerMaterial("p1Body", player1BodyMaterial);
        registerMaterial("p1Joints", player1JointsMaterial);
        registerMaterial("p2Body", player2BodyMaterial);
        registerMaterial("p2Joints", player2JointsMaterial);
        
        //Câmera fixa quase top-down enquadrando a dungeon INTEIRA: o mapa é
        //32×32 células × tile 2 = 64×64 unidades, centrado na origem pelo
        //serverToWorld do GauntletNetwork (spans ±32 em x/z). A leve inclinação
        //em +z é pra parede ter face visível, não só topo.
        const cameraNode = new Node();
        cameraNode.name = "Camera";
        vec3.set(0, 45, 27.5, cameraNode.position);
        this.rootNode.addChild(cameraNode);
        cameraNode.lookAt(vec3.create(0, 0, 0));
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        //far da app (100) clipa: o canto mais distante do mapa fica a ~130 da
        //câmera. 250 dá folga pra reposicionar sem voltar aqui.
        camera.far = 250;
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
    
        //await de propósito: o behaviour de rede só é anexado com os prefabs
        //prontos — sem isso o mapSync pode correr contra o carregamento do glb,
        //e mapSync chega UMA vez (perdeu a corrida = mundo vazio pra sempre).
        await this.loadModularDungeon();

        await this.loadP1Character(player1JointsMaterial, player1BodyMaterial);
        await this.loadP2Character(player2JointsMaterial, player2BodyMaterial);
        //adiciona capacidades de rede do world
        this.root.addBehaviour(new GauntletNetworkBehaviour(2,2));
    }

    public fabricate(position:[number, number, number],prefabName: string, parent:Node):Node {
        const prefab = this.prefabs.get(prefabName);
        if(prefab) {
            const newInstance = prefab.instantiate(this);
            newInstance.setParent(parent);
            newInstance.position[0] = position[0];
            newInstance.position[1] = position[1];
            newInstance.position[2] = position[2];
            return newInstance;
        }
        else {
            throw new Error("Prefab not found: "+prefabName);
        }
    }
    // Eu pus os pedaços da dungeon no dungeon_modular_parts.glb. A escolha de qual hierarquia
    // vira qual prefab é pelo nome do nó no blender. Não é robusto mas é o que eu pensei pra agora.
    // Talvez no futuro usar o campo de custom properties pra isso.
    private async loadModularDungeon() {
        const { nodes, meshes } = await loadGltf(this.device, "/models/dungeon_modular_parts.glb");
        //as meshes do glb são assets do World: sem isto o destroy() não as libera
        this.meshes.push(...meshes);
        nodes.forEach(node=>{
            console.log("dungeon modular: node "+node.name);
            if(node.name === "Floor00") {
                this.createPrefab(node, "Floor00");
            }
            if(node.name === "Wall00") {
                this.createPrefab(node, "Wall00");
            }
        })
    }
    // To assumindo que é o xbot do mixamo. Quando mudar isso aqui vai ter que mudar tudo
    private async loadP1Character(jointMat:Material, body:Material) {
        const {roots, nodes, meshes} = await loadGltf(this.device, "/models/xbot.glb");
        //assets do World: sem isto o destroy() não libera os buffers do xbot
        this.meshes.push(...meshes);
        for(const node of nodes) {
            if(node.renderable && node.skin) {
                node.renderable.passMask = RenderPassBit.Skinned;
                node.renderable.material = node.name === "Beta_Joints"? jointMat : body;
            }
        }
        //To assumindo que tem um root chamado Armature
        const armature = roots.find((n) => n.name === "Armature");
        if(!armature){
            throw new Error("nó armature não encontrado em xbot.glb");
        }
        //destaca pra virar template
        armature.setParent(null);
        const prefab = Prefab.fromTemplate(armature, "alice");
        this.prefabs.set("alice", prefab);
    }
    // To assumindo que é o xbot do mixamo. Qaundo mudar isso aqui vai ter que mudar tudo
    private async loadP2Character(jointMat:Material, body:Material) {
        const {roots, nodes, meshes} = await loadGltf(this.device, "/models/xbot.glb");
        this.meshes.push(...meshes);
        for(const node of nodes) {
            if(node.renderable && node.skin) {
                node.renderable.passMask = RenderPassBit.Skinned;
                node.renderable.material = node.name === "Beta_Joints"? jointMat : body;
            }
        }
        //To assumindo que tem um root chamado Armature
        const armature = roots.find((n) => n.name === "Armature");
        if(!armature){
            throw new Error("nó armature não encontrado em xbot.glb");
        }
        //destaca pra virar template
        armature.setParent(null);
        const prefab = Prefab.fromTemplate(armature, "bob");
        this.prefabs.set("bob", prefab);
    }    

    private createPrefab(n:Node, s:string){
        n.setParent(null);
        this.prefabs.set(s, Prefab.fromTemplate(n, s));
        console.log("dungeon modular: node "+n.name+" virou prefab "+s);
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        //dungeon primeiro (clear, própria textura do mainPass); os avatares
        //skinnados desenham DEPOIS, por cima, no MESMO color+depth (renderOnto
        //= load+load) — sem isso os dois passes escrevem em texturas
        //separadas e só a do mainPass chega no finalPass (avatar nunca aparece).
        this.mainPass.render(encoder, this.rootNode, width, height);
        this.skinnedPass.renderOnto(encoder, this.rootNode, this.mainPass.colorView, this.mainPass.depthView, width, height);
        this.finalPass.render(encoder, this.mainPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados
        this.root.behaviours.forEach(b=>b.dispose());
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.mainPass.destroy();
        this.finalPass.destroy();
    }
}
