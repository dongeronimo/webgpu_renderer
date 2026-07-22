/**
 * HOW-TO de como setei as skins do player:
 * 1) criei o material delas - a gente não está usando o material do blender ainda mas um uma custom property Material com a tag do material. Então eu
 *    crio o material:
 *    const dmitrySkinTexture = new TexturedSkinnedPhong (
 *      this.device, {
 *          diffuseColor:[1,1,1,1],
 *          diffuseTexture: await loadTexture(this.device, "/textures/soviet+officer+male_basecolor.jpg"),
 *          shininess:16
 *      });
 *    ATENÇÃO: TexturedSkinnedPhong, não TexturedOpaquePhong — personagem é
 *    mesh SKINNED (desenhada pelo GauntletSkinnedRenderPass), e
 *    TexturedOpaquePhong espera o grupo 1 no formato de mesh ESTÁTICA
 *    (ObjectData{model,normalMatrix}), não SkinObject{pose[],boneModel[]}.
 *    Usar o material errado não dá erro nenhum — só nunca anima (T-pose
 *    fixo) e "desliza" com a pose crua do osso 0 por cima do buffer errado.
 *    Se for um personagem sem esqueleto/estático, aí sim TexturedOpaquePhong.
 *    obs.: é custom prop do NODE, não do material. É a custom prop que aparece no fundo da aba quando seleciona o retângulozinho laranja
 * 2) Registro o material no registro de material:
 *    registerMaterial("DmitryMaterial", dmitrySkinTexture);
 *    A chave tem que bater exatamente com a string no custom prop do blender, é via ===.
 *
 */

//Mundo do GAUNTLET — client da vertical multiplayer (server Spring Boot em
//gauntlet_server/; spec em src/instructions/multiplayer.md). Estágio 0: só o
//cubo unitário na tela, câmera fixa e luz no alto — o esqueleto onde a parte
//de rede (WebSocket, snapshots, interpolação) vai ser construída. Mundo
//separado de propósito: experimento novo não mexe nos mundos fechados.
//
//Tem passes e materiais PRÓPRIOS (gauntletMainRenderPass/gauntletSkinnedRenderPass
//+ gauntlet/materials/*): Gauntlet é o 1o mundo com suporte a múltiplas luzes
//(point/spot/directional), então divergiu do MainRenderPass/SkinnedRenderPass
//genéricos que Train/GameVolume/StarshipDemo ainda usam com 1 luz só — ver
//gauntletLighting.ts pro porquê da divergência.
import { vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
import { TonemapPass } from "../tonemapPass";
import { World } from "../world";
import { Node } from "../node";
import { Mesh } from "../mesh";
import {  RenderPassBit } from "../renderable";
import { DirectionalLight } from "../Light";
import { loadGltf } from "../gltfLoader";
import { getMaterial, registerMaterial } from "../material";
import { GauntletLighting } from "./gauntletLighting";
import { GauntletMainRenderPass } from "./gauntletMainRenderPass";
import { GauntletShadowPass } from "./gauntletShadowPass";
import { PhongColorMaterial } from "./materials/PhongColorMaterial";
import GauntletNetworkBehaviour from "./GauntletNetwork";
import { TexturedOpaquePhong } from "./materials/TexturedOpaquePhong";
import { TexturedSkinnedPhong } from "./materials/TexturedSkinnedPhong";
import { loadTexture } from "../textureLoader";
import { Prefab } from "../prefab";
import PrefabFabricator from "../PrefabFabricator";
import { GauntletSkinnedRenderPass } from "./gauntletSkinnedRenderPass";
import { AnimatorBehaviour } from "../skinning/AnimatorBehaviour";
import type { AnimationClip } from "../animation";
import { store } from "../redux/store";

//A dungeon só é INSTANCIADA via rede (fabricate de Wall00/Floor00 no
//mapSync do GauntletNetwork), bem depois do createWorld() retornar — não dá
//pra computar o AABB de verdade da cena aqui (a árvore ainda não tem
//geometria nenhuma). Uso a extensão CONHECIDA do mapa (mesmo comentário da
//câmera abaixo: 32×32 células × tile 2 = 64×64, centrado na origem) com
//margem generosa de altura, só pra fitar o ortho da sombra do directional.
const DUNGEON_SHADOW_BOUNDS_MIN = vec3.create(-35, -1, -35);
const DUNGEON_SHADOW_BOUNDS_MAX = vec3.create(35, 20, 35);

//Alvo do mainPass/skinnedPass em HDR de verdade: luz pode passar de 1.0 sem
//clipar aqui — o clip vira uma curva suave (Reinhard) só no TonemapPass,
//na hora de compor no backbuffer (esse sim 8-bit, formato do canvas).
const HDR_COLOR_FORMAT: GPUTextureFormat = "rgba16float";

export class GauntletWorld extends World implements PrefabFabricator {
    private mainPass!: GauntletMainRenderPass;
    private finalPass!: TonemapPass;
    private canvas!: HTMLCanvasElement;
    public meshes: Mesh[] = [];
    public prefabs: Map<string, Prefab> = new Map();
    private skinnedPass!: GauntletSkinnedRenderPass;
    private lighting!: GauntletLighting;
    private shadowPass!: GauntletShadowPass;
    //lastSeen (mesmo padrão de VolumeRaycastBehaviour/SetCtfBehaviour) — só
    //que aqui é o WORLD que lê o redux a cada update(), não uma behaviour:
    //exceção combinada com o usuário, exigida porque redimensionar os
    //render targets de sombra é responsabilidade de quem os possui.
    private lastShadowMapSize = store.getState().gauntlet.shadowMapSize;
    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.lighting = new GauntletLighting(this.device);
        this.shadowPass = new GauntletShadowPass(this.device);
        //HDR_COLOR_FORMAT nos dois: skinnedPass desenha via renderOnto no
        //MESMO color+depth do mainPass (ver render() abaixo), então o
        //pipeline dele precisa ser criado com o formato real daquele alvo,
        //não com o do canvas.
        this.skinnedPass = new GauntletSkinnedRenderPass(this.device, this.lighting, HDR_COLOR_FORMAT, "clear");
        //"clear": aqui é o PRIMEIRO pass a tocar o alvo — desenha a dungeon,
        //e o skinnedPass entra DEPOIS por cima via renderOnto (color+depth
        //"load"), senão o chão (opaco, cobre a tela inteira na câmera
        //top-down) sobrescreveria os avatares. depthStoreOp "store" (não o
        //default "discard"): sem isso o depth do mainPass some antes do
        //skinnedPass poder testar contra ele — o teste falha pra tudo e o
        //avatar não desenha nenhum pixel, mesmo desenhado com sucesso.
        this.mainPass = new GauntletMainRenderPass(this.device, this.lighting, HDR_COLOR_FORMAT, "clear", "store");
        //TonemapPass é quem continua no formato do canvas — é ele que
        //apresenta, e a swapchain só aceita o preferredCanvasFormat.
        this.finalPass = new TonemapPass(this.device, canvas, canvasFormat);
    }

    /**
     * Lê o redux a cada frame (padrão lastSeen) e manda a GauntletLighting
     * redimensionar os shadow maps quando o usuário muda o campo na UI —
     * ver GauntletShadowSettingsPanel.tsx.
     */
    override update(deltaTime: number): void {
        super.update(deltaTime);
        const shadowMapSize = store.getState().gauntlet.shadowMapSize;
        if (shadowMapSize !== this.lastShadowMapSize) {
            this.lastShadowMapSize = shadowMapSize;
            this.lighting.setShadowMapSize(shadowMapSize);
        }
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
        //TexturedSkinnedPhong, não TexturedOpaquePhong: Dmitry/Nat são meshes
        //SKINNED (desenhados pelo GauntletSkinnedRenderPass, grupo 1 =
        //SkinObject) — TexturedOpaquePhong espera ObjectData{model,normalMatrix}
        //no grupo 1 (é o que GauntletMainRenderPass fornece) e nunca lê
        //joints/weights, então nunca desformava a mesh (T-pose sempre) e
        //"model" na prática lia pose[0] do buffer errado (daí o corpo inteiro
        //balançando junto com aquele osso). Ver TexturedSkinnedPhong.ts.
        const dmitrySkinTexture = new TexturedSkinnedPhong (
            this.device, {
                diffuseColor:[1,1,1,1],
                diffuseTexture: await loadTexture(this.device, "/textures/soviet+officer+male_basecolor.jpg"),
                shininess: 16
            }
        );
        const natSkinTexture = new TexturedSkinnedPhong (
            this.device, {
                diffuseColor:[1,1,1,1],
                diffuseTexture: await loadTexture(this.device, "/textures/soviet+female+officer_basecolor.jpg"),
                shininess: 16
            }
        );
        const abiSkinTexture = new TexturedSkinnedPhong (
            this.device, {
                diffuseColor:[1,1,1,1],
                diffuseTexture: await loadTexture(this.device, "/textures/abigail_basecolor.jpg"),
                shininess: 32
            }
        );
        const ramirezSkinTexture = new TexturedSkinnedPhong (
            this.device, {
                diffuseColor:[1,1,1,1],
                diffuseTexture: await loadTexture(this.device, "/textures/ramirez-military+character+3d+model_basecolor.jpg"),
                shininess: 16
            }
        )
        registerMaterial("clay", clay);
        registerMaterial("blackRock", blackRock);
        registerMaterial("DmitryMaterial", dmitrySkinTexture);
        registerMaterial("natMaterial", natSkinTexture);
        registerMaterial("abigailSkin", abiSkinTexture);
        registerMaterial("ramirezSkin", ramirezSkinTexture);
        
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

        //Fita o ortho da sombra do directional na extensão conhecida do
        //mapa (ver comentário no topo do arquivo) — precisa estar pronto
        //antes do 1º render(), não depende de nenhuma luz existir ainda.
        this.lighting.setShadowSceneBounds(DUNGEON_SHADOW_BOUNDS_MIN, DUNGEON_SHADOW_BOUNDS_MAX);

        //Luz GLOBAL da cena: DirectionalLight, não PointLight. Dois motivos:
        //1) point/spot atenuam por DISTÂNCIA (atten = intensity/dist, linear
        //   — ver PhongColorMaterial), então uma luz "de teto" a 150-190u de
        //   distância da dungeon inteira precisa de intensity gigante (chegou
        //   a 250) só pra não ficar escura, e ainda assim varia muito entre o
        //   canto mais perto e o mais longe do mapa. Directional não atena
        //   com distância nenhuma (fonte infinitamente distante) — intensity
        //   pequena já ilumina a dungeon TODA por igual.
        //2) point light ainda NÃO tem shadow map neste engine (só spot e
        //   directional — ver gauntletLighting.ts), por isso "parecia não
        //   gerar sombra": literalmente não gerava, é limitação conhecida,
        //   não bug. Directional já tem toda a infra pronta e ESPERANDO (ver
        //   setShadowSceneBounds acima, DUNGEON_SHADOW_BOUNDS_MIN/MAX) — só
        //   faltava um directional de verdade na cena pra usá-la.
        //lookAt em vez de (0,1,0) reto pra baixo: ângulo dá sombras longas e
        //legíveis no chão em vez de sombras curtas quase só embaixo do pé.
        //Posição não importa pra iluminação/sombra (direction vem só da
        //rotação, computeDirectionalShadowViewProj monta a câmera sintética a
        //partir da cena, não da posição do nó) — só precisa ser um ponto que
        //dê a direção certa pro lookAt, então reaproveita as mesmas coordenadas
        //de antes.
        const light = new Node();
        light.name = "Light0";
        vec3.set(60, 150, 60, light.position);
        this.rootNode.addChild(light);
        light.lookAt(vec3.create(0, 0, 0));
        const sun = new DirectionalLight();
        sun.color = [1, 0.97, 0.92];
        sun.intensity = 1.1;
        light.light = sun;

        //Padrão dos outros mundos: behaviours enxergam o World.
        this.getAllNodes()
            .filter(n => n.behaviours.length > 0)
            .forEach(n => (n.world = this));
    
        //await de propósito: o behaviour de rede só é anexado com os prefabs
        //prontos — sem isso o mapSync pode correr contra o carregamento do glb,
        //e mapSync chega UMA vez (perdeu a corrida = mundo vazio pra sempre).
        await this.loadModularDungeon();

        //Clips de idle/walk/walkBackward — mesmo esqueleto do rig mixamorig:*,
        //casam por nome sem retargeting (ver animation.ts). UM carregamento só,
        //compartilhado entre os templates "Dmitry" e "Nat" (AnimationClip é
        //asset sem ref a Node — ver skinning-system).
        const idleClip = await this.loadAnimClip("/anims/rifle_idle.glb");
        const walkClip = await this.loadAnimClip("/anims/rifle_walk_forward.glb");
        const walkBackwardClip = await this.loadAnimClip("/anims/rifle_walk_backward.glb");
        //carrega os bonecos de russos — os dois personagens jogáveis (ver
        //modal de escolha pós-login). O NOME do prefab ("Dmitry"/"Nat") é a
        //MESMA string que viaja em JoinRequest.character/EntityDto.character
        //(GauntletNetwork.onEntsAdded fabrica direto por esse nome).
        await this.loadHeroes("/models/Dmitry.glb", "Dmitry",  idleClip, walkClip, walkBackwardClip);
        await this.loadHeroes("/models/Nat.glb", "Nat",  idleClip, walkClip, walkBackwardClip);
        await this.loadHeroes("/models/abi.glb", "Abigail",  idleClip, walkClip, walkBackwardClip);
        await this.loadHeroes("/models/ramirez.glb", "Ramirez",  idleClip, walkClip, walkBackwardClip);
        
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
    //Um clip só-de-keyframes (sem mesh), mesmo padrão do capoeira.glb do
    //SkinningDemoWorld — ver skinning-system.
    private async loadAnimClip(path: string): Promise<AnimationClip> {
        const result = await loadGltf(this.device, path);
        const clip = result.animations[0];
        if (!clip) {
            throw new Error(`GauntletWorld: "${path}" sem animação.`);
        }
        return clip;
    }

    //Anexa idle/walk/walkBackward no ROOT do template (armature), ANTES do
    //Prefab.fromTemplate — mesma convenção de `AnimatorBehaviour.clip`: os
    //três states são autorados aqui uma vez, cada instância clonada resolve
    //os PRÓPRIOS bindings no start() (ver AnimatorBehaviour). "walkBackward"
    //TEM que bater com o nome que GameLoop.stepMovement manda no `state` do
    //snap, senão playState só loga um warning e ignora (ver AnimatorBehaviour).
    private attachAnimator(armature: Node, idleClip: AnimationClip, walkClip: AnimationClip, walkBackwardClip: AnimationClip): void {
        const animator = new AnimatorBehaviour();
        animator.registerState("idle", idleClip, { loop: true });
        animator.registerState("walk", walkClip, { loop: true });
        animator.registerState("walkBackward", walkBackwardClip, { loop: true });
        animator.initialState = "idle";
        armature.addBehaviour(animator);
    }
    //TODO refactor: os clips deveriam ficar numa struct ao invés de params soltos
    private async loadHeroes(file:string, prefabName:string, idleClip: AnimationClip, walkClip: AnimationClip, walkBackwardClip: AnimationClip){
        const {roots, nodes, meshes} = await loadGltf(this.device, file);
        this.meshes.push(...meshes); //se não guardar no World vai vazar quando trocar de world.
        //atribui material ao dmitry. 
        nodes.filter(n=>n.renderable && n.skin).forEach(n=>{
            n.renderable!.passMask = RenderPassBit.Skinned;
            const matName = n.extras.Material as string;
            console.log(`${file} mat name = ${matName}`);
            n.renderable!.material = getMaterial(matName);
        });
        //To assumindo que tem um root chamado Armature. todos os bonecos que vêm do Blender tem
        const armature = roots.find(n=>n.name==="Armature");
        if(!armature) throw new Error(`nó armature não encontrado no ${file}`);
        //detach do mundo pra virar template (prefab)
        armature.setParent(null);
        this.attachAnimator(armature, idleClip, walkClip, walkBackwardClip);
        const prefab = Prefab.fromTemplate(armature, prefabName);
        this.prefabs.set(prefabName, prefab);
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
        //UMA coleta de luzes por frame, compartilhada pelos dois passes —
        //ver gauntletLighting.ts.
        this.lighting.updateFrame(this.rootNode, width, height);
        //Shadow maps de spot/directional ANTES do main/skinned pass — eles
        //amostram essas texturas no fragment shader (ver gauntletLighting.ts).
        this.shadowPass.render(encoder, this.rootNode, this.lighting);
        //dungeon primeiro (clear, própria textura do mainPass); os avatares
        //skinnados desenham DEPOIS, por cima, no MESMO color+depth (renderOnto
        //= load+load) — sem isso os dois passes escrevem em texturas
        //separadas e só a do mainPass chega no finalPass (avatar nunca aparece).
        this.mainPass.render(encoder, this.rootNode, width, height);
        this.skinnedPass.renderOnto(encoder, this.rootNode, this.mainPass.colorView, this.mainPass.depthView);
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
        this.skinnedPass.destroy();
        this.shadowPass.destroy();
        this.lighting.destroy();
        this.finalPass.destroy();
    }
}
