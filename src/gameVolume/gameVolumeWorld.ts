//Mundo do VOLUME EM JOGO — o volume rendering deixa a mesa do radiologista e
//vai pro contexto de jogo: uma fumaça procedural volumétrica que CONVIVE com
//geometria opaca iluminada (Phong), com oclusão nos dois sentidos.
//
//Estágio 0 (este): mundo novo + cena (chão + blocos) + fumaça animada +
//OCLUSÃO bidirecional. A geometria opaca é desenhada primeiro (cor + depth,
//depthStoreOp "store"); o SmokeVolumePass compõe a fumaça por cima LENDO esse
//depth pra parar a marcha na superfície opaca. Resultado: os blocos que
//atravessam a fumaça a ocluem, e a fumaça densa oclui os blocos atrás dela.
//
//Estágios 2 e 3 (SHADING/SOMBRAS — este arquivo hoje): a luz virou SOL
//(direcional; a point light já estava a dist ~192, era um sol de fato) e o
//frame ganhou a cadeia de sombras completa:
//  1. simulação (compute) — a densidade deste frame, ANTES de qualquer sombra;
//  2. SunShadowPass — shadow map ortho da geometria, do ponto de vista do sol;
//  3. SmokeTransmittancePass — quanta luz ATRAVESSA a fumaça em cada raio de
//     sol (a sombra que a fumaça projeta na cena);
//  4. SunScenePass + SunPhongMaterial — geometria com Phong direcional + PCF
//     do shadow map + escurecida pela transmitância da fumaça;
//  5. SmokeVolumePass — fumaça com single scattering: auto-sombra (marcha até
//     o sol), sombra da geometria (tap no shadow map), fase Henyey-Greenstein
//     e ambiente. Tudo concorda porque o MESMO Sun (direção + viewProj) é
//     calculado uma vez por frame e passado a todos.
//
//Reusa OrbitCameraBehaviour (raycaster) pra câmera; a OrbitLightBehaviour
//continua movendo o node da luz — daí sai só a DIREÇÃO do sol, então as
//sombras giram ao vivo na demo.
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
import { OrbitCameraBehaviour } from "../raycast/orbitCameraBehaviour";
import { SmokeVolumePass } from "./smokeVolumePass";
import { OrbitLightBehaviour } from "./orbitLightBehaviour";
import { SmokeBehaviour } from "./smokeBehaviour";
import { SunScenePass } from "./sunScenePass";
import { SunPhongMaterial } from "./sunPhongMaterial";
import { SunShadowPass } from "./sunShadowPass";
import { SmokeTransmittancePass } from "./smokeTransmittancePass";
import { buildSunMatrices, type Sun } from "./sun";

export class GameVolumeWorld extends World {
    private scenePass!: SunScenePass;
    private shadowPass!: SunShadowPass;
    private transmittancePass!: SmokeTransmittancePass;
    private volumePass!: SmokeVolumePass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    private cameraNode!: Node;
    private lightNode!: Node;
    public meshes: Mesh[] = [];
    //O cérebro da fumaça (dono da AdvectionSim), guardado pra dispose na troca
    //de mundo — World.destroy não roda dispose das behaviours.
    private smoke!: SmokeBehaviour;

    //Propriedades do sol (a DIREÇÃO vem do node da luz, que orbita).
    private readonly sunColor: [number, number, number] = [1.0, 0.97, 0.9];
    //~a mesma energia da era point light (250/dist≈1.3), sem a atenuação.
    private readonly sunIntensity = 1.4;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        //Geometria opaca (Phong direcional + sombras) → cor + depth. "store" no
        //depth pra o volume pass poder lê-lo (oclusão da fumaça).
        this.scenePass = new SunScenePass(this.device, canvasFormat, "clear", "store");
        this.shadowPass = new SunShadowPass(this.device);
        this.transmittancePass = new SmokeTransmittancePass(this.device);
        this.volumePass = new SmokeVolumePass(this.device, canvasFormat);
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //Câmera orbital (mesma OrbitCameraBehaviour do raycaster; lê a órbita do
        //redux — a captura de mouse é o OrbitControls do App). Alvo um pouco
        //acima do chão, no miolo da fumaça.
        this.cameraNode = new Node();
        this.cameraNode.name = "Camera";
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        camera.far = perspective.far;
        this.cameraNode.camera = camera;
        this.rootNode.addChild(this.cameraNode);
        this.cameraNode.addBehaviour(new OrbitCameraBehaviour(vec3.create(0, 0.4, 0)));

        //Luz orbitando — agora só a DIREÇÃO do sol sai daqui (normalize(alvo -
        //posição)); a distância não importa mais (direcional não atenua). A
        //órbita fica: sombras da geometria E da fumaça girando ao vivo na demo.
        this.lightNode = new Node();
        this.lightNode.name = "Light0";
        this.lightNode.light = new Light();
        this.rootNode.addChild(this.lightNode);
        this.lightNode.addBehaviour(new OrbitLightBehaviour(vec3.create(0, 0, 0), 120, 150, 0.35));

        //Materiais da cena (registrados → super.destroy() os libera na troca).
        //SunPhongMaterial: Phong direcional + shadow map (PCF) + sombra da
        //fumaça (transmitância). Ambiente ~0.22× da cor base segue sendo o fill
        //que impede a face oposta ao sol de ir a preto.
        const floorMat = new SunPhongMaterial(this.device, [0.55, 0.55, 0.58, 1], [0.12, 0.12, 0.13], 64);
        const redMat = new SunPhongMaterial(this.device, [0.80, 0.25, 0.20, 1], [0.18, 0.05, 0.04], 128);
        const blueMat = new SunPhongMaterial(this.device, [0.20, 0.45, 0.80, 1], [0.05, 0.10, 0.18], 128);
        const greenMat = new SunPhongMaterial(this.device, [0.30, 0.62, 0.35, 1], [0.07, 0.14, 0.08], 128);
        registerMaterial("floor", floorMat);
        registerMaterial("red", redMat);
        registerMaterial("blue", blueMat);
        registerMaterial("green", greenMat);

        //Um cubo unitário ([-0.5,0.5]³) — a MESMA mesh serve a todos os nós
        //(chão, blocos e o proxy do volume), com transform/material por nó.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        this.meshes.push(...cube.meshes);
        const cubeMesh = cube.meshes[0];
        if (!cubeMesh) {
            throw new Error("GameVolumeWorld: unitary_cube.glb sem mesh.");
        }

        //Chão + blocos. O chão NÃO é obstáculo do fluido (fica sob o volume);
        //os blocos que cruzam o volume viram obstáculos. O SmokeBlocker é a
        //estrela: uma laje larga bem no caminho da coluna, pra ela RACHAR nele.
        this.addBox("Floor", cubeMesh, floorMat, [0, -0.6, 0], [5, 0.3, 5]);
        const blockRed = this.addBox("BlockRed", cubeMesh, redMat, [-1.1, -0.1, -0.6], [0.5, 0.9, 0.5]);
        const blockBlue = this.addBox("BlockBlue", cubeMesh, blueMat, [1.0, 0.15, 0.4], [0.55, 1.5, 0.55]);
        const blockGreen = this.addBox("BlockGreen", cubeMesh, greenMat, [0.25, -0.3, 1.15], [0.7, 0.5, 0.7]);
        const pillar = this.addBox("Pillar", cubeMesh, floorMat, [-0.2, 0.1, 0.2], [0.22, 1.7, 0.22]);
        const smokeBlocker = this.addBox("SmokeBlocker", cubeMesh, blueMat, [0, 0.5, 0], [1.2, 0.28, 1.2]);
        const obstacleNodes = [blockRed, blockBlue, blockGreen, pillar, smokeBlocker];

        //O node de FUMAÇA: âncora de transform (ORIGEM do volume, transladável)
        //+ SmokeBehaviour (o cérebro, dono da AdvectionSim). O Renderable (cubo,
        //passMask = Volume) é o proxy que o SmokeVolumePass desenha e o
        //MainRenderPass ignora. PODE haver mais de um — o pass coleta todos.
        //A voxelização dos obstáculos é relativa a ESTE node (a behaviour a faz).
        const smokeNode = new Node();
        smokeNode.name = "Smoke";
        const smokeRenderable = new Renderable(cubeMesh);
        smokeRenderable.passMask = RenderPassBit.Volume;
        smokeNode.renderable = smokeRenderable;
        //Volume um pouco maior (dá espaço pro rastro quando o volume anda).
        vec3.set(0, 0.5, 0, smokeNode.position);
        vec3.set(2.8, 2.4, 2.8, smokeNode.scale);
        this.smoke = new SmokeBehaviour(this.device, {
            grid: 96,
            plumeSpeed: 20,
            dissipationRate: 0.3,   //mantém a fumaça em regime estável
            revoxelizeInterval: 15, //re-voxeliza obstáculos a cada 15 frames
            obstacleRange: 0.5,     //broad-phase: sólidos a até 0.5u do volume
        });
        this.smoke.setObstacleNodes(obstacleNodes);
        smokeNode.addBehaviour(this.smoke);
        this.rootNode.addChild(smokeNode);

        //Cobertura baixa: a densidade simulada tem borda macia (senão o
        //smoothstep come a casca).
        this.volumePass.coverage = 0.08;

        //Garante que as behaviours enxerguem o World (padrão dos outros mundos).
        this.getAllNodes()
            .filter(n => n.behaviours.length > 0)
            .forEach(n => (n.world = this));
    }

    /** Cria um nó-cubo (chão/bloco) com material Phong e o pendura no root. */
    private addBox(
        name: string,
        mesh: Mesh,
        material: SunPhongMaterial,
        pos: [number, number, number],
        scale: [number, number, number],
    ): Node {
        const node = new Node();
        node.name = name;
        const renderable = new Renderable(mesh);
        renderable.material = material;
        node.renderable = renderable;
        vec3.set(pos[0], pos[1], pos[2], node.position);
        vec3.set(scale[0], scale[1], scale[2], node.scale);
        this.rootNode.addChild(node);
        return node;
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.canvas.width;
        const height = this.canvas.height;

        //0. Simulação PRIMEIRO: os passes de sombra leem a densidade JÁ
        //advectada deste frame (a barreira compute→render é do WebGPU).
        this.volumePass.simulate(encoder, this.rootNode);

        //O SOL deste frame: direção do node da luz (worldMatrix fresco — o
        //update já rodou) + matrizes de light-space. UM Sun pra todos os
        //passes, senão cada sombra apontaria pra um lado.
        const lm = this.lightNode.worldMatrix;
        const { dir, viewProj } = buildSunMatrices(
            vec3.create(lm[12], lm[13], lm[14]),
            vec3.create(0, 0, 0),
        );
        const sun: Sun = { dir, viewProj, color: this.sunColor, intensity: this.sunIntensity };

        //1. Shadow map: a cena vista do sol (depth-only).
        this.shadowPass.render(encoder, this.rootNode, sun.viewProj);

        //2. Transmitância da fumaça em light-space (a sombra QUE ELA projeta).
        //Espelha os tunables do volume pass: sombra e fumaça têm que ser a
        //MESMA fumaça (mesmo threshold/escala/extinção).
        this.transmittancePass.sigma = this.volumePass.sigma;
        this.transmittancePass.coverage = this.volumePass.coverage;
        this.transmittancePass.densityScale = this.volumePass.densityScale;
        this.transmittancePass.render(encoder, this.rootNode, sun, this.shadowPass.depthView);

        //3. Geometria opaca → cor + depth, com sombra dura (shadow map) e
        //sombra da fumaça (transmitância).
        this.scenePass.render(
            encoder, this.rootNode, width, height,
            sun, this.shadowPass.depthView, this.transmittancePass.view,
        );

        //4. Fumaça: single scattering (auto-sombra + sombra da geometria),
        //composta por cima, ocluída pelo depth dos opacos.
        this.volumePass.render(
            encoder,
            this.scenePass.colorView,
            this.scenePass.depthView,
            this.cameraNode,
            this.rootNode,
            width,
            height,
            sun,
            this.shadowPass.depthView,
        );

        //5. Composição do offscreen no backbuffer.
        this.finalPass.render(encoder, this.scenePass.colorView);
    }

    override destroy(): void {
        super.destroy(); //materiais registrados
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.smoke.dispose(); //libera a AdvectionSim (World.destroy não roda dispose)
        this.scenePass.destroy();
        this.shadowPass.destroy();
        this.transmittancePass.destroy();
        this.volumePass.destroy();
        this.finalPass.destroy();
    }
}
