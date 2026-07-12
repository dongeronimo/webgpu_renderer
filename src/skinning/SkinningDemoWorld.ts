import { vec3 } from "wgpu-matrix";
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { World } from "../world";
import { loadGltf } from "../gltfLoader";
import { Mesh } from "../mesh";
import { Node } from "../node";
import { Light } from "../Light";
import { RenderPassBit } from "../renderable";
import { Prefab } from "../prefab";
import { registerMaterial } from "../material";
import { SkinnedRenderPass } from "./skinnedRenderPass";
import { SkinnedPhongMaterial } from "./SkinnedPhongMaterial";
import { AnimatorBehaviour } from "./AnimatorBehaviour";

//Primeiro mundo de skinning. Meta desta etapa: CARREGAR a skin (xbot.glb:
//armature + duas meshes skinnadas) e desenhá-la em bind pose pelo
//SkinnedRenderPass, provando a estrutura ponta-a-ponta (loader → Skin →
//prefab → pass → shader LBS). A animação vem numa etapa seguinte.
//
//O xbot já traz a hierarquia que a gente queria: o nó "Armature" é o root
//que parenteia a raiz do esqueleto (mixamorig:Hips) E as meshes
//(Beta_Joints, Beta_Surface). Então ele vira o TEMPLATE do prefab: uma
//instância = uma cópia com esqueleto próprio (o clone remapeia os ossos da
//skin — ver prefab.ts).
export class SkinningDemoWorld extends World {
    public meshes: Mesh[] = [];
    private xbotPrefab!: Prefab;
    private skinnedPass!: SkinnedRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        //Único pass de cor do mundo: limpa o alvo ele mesmo (não há skybox).
        this.skinnedPass = new SkinnedRenderPass(this.device, canvasFormat, "clear");
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number }): Promise<void> {
        //Materiais do xbot. Os nomes batem com os do glb (Beta_HighLimbsGeoSG3 =
        //corpo, Beta_Joints_MAT1 = juntas), mas o glb não traz a custom property
        //"MaterialName", então o loader não os liga sozinho — a gente atribui na
        //mão abaixo. Registrar mesmo assim deixa o World.destroy() liberá-los.
        const bodyMaterial = new SkinnedPhongMaterial(this.device, [0.72, 0.73, 0.75, 1], [0.06, 0.06, 0.07], 48);
        const jointsMaterial = new SkinnedPhongMaterial(this.device, [0.90, 0.45, 0.10, 1], [0.08, 0.04, 0.01], 24);
        registerMaterial("Beta_HighLimbsGeoSG3", bodyMaterial);
        registerMaterial("Beta_Joints_MAT1", jointsMaterial);

        const { roots, nodes, meshes } = await loadGltf(this.device, "/models/xbot.glb");
        this.meshes.push(...meshes);

        //Liga material + pass em cada mesh skinnada do TEMPLATE (antes de virar
        //prefab, pra que o clone herde por referência via cloneRenderable).
        for (const node of nodes) {
            if (node.renderable && node.skin) {
                node.renderable.passMask = RenderPassBit.Skinned;
                node.renderable.material = node.name === "Beta_Joints" ? jointsMaterial : bodyMaterial;
            }
        }

        //O nó "Armature" é o root do personagem (esqueleto + meshes). Vira o
        //template do prefab; o resto do glb (o nó Camera) fica de fora.
        const armature = roots.find((n) => n.name === "Armature");
        if (!armature) {
            throw new Error("SkinningDemoWorld: nó 'Armature' não encontrado no xbot.glb.");
        }
        armature.setParent(null); //destaca o template do resto do glb

        //Animação: o xbot vem sem anim de verdade — o clip vem de um arquivo
        //só-de-keyframes do Mixamo (capoeira.glb, sem mesh). Mesmo esqueleto
        //(nomes mixamorig:*), então casa por nome sem retargeting. A
        //AnimatorBehaviour vai no ROOT do template; o clone dá a cada instância
        //o seu playback próprio (o binding nome→osso é resolvido no start()
        //de cada cópia, contra os ossos dela).
        const capoeira = await loadGltf(this.device, "/anims/capoeira.glb");
        const clip = capoeira.animations[0];
        if (!clip) {
            throw new Error("SkinningDemoWorld: capoeira.glb sem animação.");
        }
        const animator = new AnimatorBehaviour();
        animator.clip = clip;
        armature.addBehaviour(animator);

        this.xbotPrefab = Prefab.fromTemplate(armature, "Xbot");

        //Instancia UM xbot (exercita o caminho de clone + remap de ossos da
        //skin). Fica no bind pose — sem animação ainda.
        const xbot = this.xbotPrefab.instantiate(this);
        this.rootNode.addChild(xbot);

        //Câmera: o modelo em bind pose fica em coords locais da mesh (~1.8 de
        //altura, Y-up, pés na origem), pois a pose = boneWorld·inverseBind vira
        //identidade e cancela a rotação/escala baked da Armature. Enquadra de
        //frente, um pouco acima do centro.
        const cameraNode = new Node();
        cameraNode.name = "Camera";
        vec3.set(0, 1.0, 3.6, cameraNode.position);
        this.rootNode.addChild(cameraNode);
        cameraNode.lookAt(vec3.create(0, 0.95, 0));
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = 0.05;
        camera.far = 100;
        cameraNode.camera = camera;

        //Luz DIRECIONAL: no shader skinnado a "posição" do nó de luz é lida
        //como DIREÇÃO (ver SkinnedPhongMaterial). Vindo de cima, à frente.
        const light = new Node();
        light.name = "Light0";
        vec3.set(0.4, 0.9, 0.7, light.position);
        light.light = new Light();
        this.rootNode.addChild(light);
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.skinnedPass.render(encoder, this.rootNode, width, height);
        this.finalPass.render(encoder, this.skinnedPass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados (body/joints)
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.skinnedPass.destroy();
        this.finalPass.destroy();
    }
}
