import { mat4, vec3, type Mat4 } from "wgpu-matrix";
import { Camera } from "../camera";
import { FinalRenderPass } from "../finalPass";
import { MeshRenderPass } from "../meshPass";
import { World } from "../world";
import { Node } from "../node";
import { Mesh } from "../mesh";
import { loadGltf } from "../gltfLoader";
import { loadVolumeTexture } from "../volumeLoader";
import { dicomTagNumber, sliceSpacingMm } from "../volume-types";
import { store } from "../redux/store";
import type { RootState } from "../redux/reducers";
import {
    examLoadFailed, examLoadFinished, examLoadStarted, examShowSelection,
    hideLoadingScreen, setCtfHuRange, setCtfWindow, showLoadingScreen,
} from "../redux/actions";
import { VolumeRaycastLassoMaterial } from "./volumeRaycastLassoMaterial";
import { VolumeRaycastLassoBehaviour } from "./volumeRaycastLassoBehaviour";
import { OrbitCameraBehaviour } from "../raycast/orbitCameraBehaviour";
import { FramebufferAutoScaleBehaviour } from "../raycast/framebufferAutoScaleBehaviour";
import { createGradientTexture, gradientParamsFromMetadata } from "../textureStackVolumeRenderCT/gradientCompute";
import { Behaviour } from "../behaviour";
import { loadChunkOccupancy } from "../raycastESS/chunkOccupancy";
import { LassoSatCache, skipMapWithLassos } from "./lassoChunkCull";
import { DebugChunksPass } from "../raycastESS/debugChunksPass";
import { DebugChunksOverlayPass } from "../raycastESS/debugChunksOverlayPass";

//Mesma behaviour de resize do baseline: lê o framebufferScale do redux e
//redimensiona o alvo do main pass (menos fragmentos = menos raios).
class FramebufferResizerBehaviour extends Behaviour {
    update(_: number): void {
        const scale = store.getState().raycast.framebufferScale;
        const w = this.node.world as RaycastLassoWorld;
        w.resizeFramebuffer(scale);
    }
}

//Gateia a ENTRADA do mundo: sem exame escolhido abre o modal, com exame
//escolhido dispara a carga (fase 2). Mesmo desenho da escolha de personagem do
//gauntlet — o modal é UI, mas quem sabe QUANDO abri-lo é o mundo, porque é ele
//que sabe se há um volume montado.
//
//Roda no root, que já tem .world desde o ctor do World.
class ExamSelectionBehaviour extends Behaviour {
    update(_: number): void {
        const exam = store.getState().exam;
        const world = this.node.world as RaycastLassoWorld;
        if (exam.selected === null) {
            //Sem exame: pede a tela. O !choosing evita despachar todo frame.
            if (!exam.choosing) {
                store.dispatch(examShowSelection());
            }
            return;
        }
        //Com exame: garante que ele está carregado. Idempotente — o world
        //guarda qual path já está em voo, então chamar todo frame não relança.
        world.ensureExamLoaded(exam.selected.path);
    }
}

//O PiP de debug é um quadzinho no canto (~0.28 da tela): renderá-lo no tamanho
//CHEIO do canvas é desperdício. ~0.4 cobre o display com folga de supersampling
//e corta o custo do pass em ~6x. Escala os DOIS eixos igual → mantém o aspecto
//(o overlay não estica).
const DEBUG_PIP_RES_SCALE = 0.4;

// Mundo do RAYCASTER DO LASSO — clone NÃO-DESTRUTIVO do RaycastESSWorld
// (../raycastESS/), que fica intacto como baseline pra A/B no gpuTimer.
//
// Herda TUDO do ESS: proxy-cube, CTF pré-integrada, gradiente, framebuffer
// scaling, skip-map por chunk e o PiP de debug dos chunks. As peças puramente
// CPU do ESS (chunkOccupancy) e os passes de debug são IMPORTADOS de
// ../raycastESS em vez de duplicados — são read-only, não há o que divergir.
// O que é clonado de verdade é o par material+behaviour, porque o corte por
// lasso mora no shader e no sync UI→engine.
//
// ONDE ELE JÁ DIVERGIU DO ESS: o exame. O ESS (e o baseline) carregam um
// VOLUME_URL fixo dentro do createWorld; aqui o mundo nasce só com câmera, um
// modal lista o que existe em /volumes/index.json e o volume renderer inteiro
// só é montado depois da escolha — ver loadExam() e ExamSelectionBehaviour.
//
// O QUE JÁ CORTA: o usuário arma o lasso na barra de ferramentas (o overlay de
// captura cobre a camada de órbita, congelando a câmera), desenha o contorno, e
// no pointerup o par (contorno em NDC, clipFromLocal congelada) vira um
// LassoData no redux. A behaviour vê a referência do array trocar, o material
// rasteriza cada contorno numa camada do texture_2d_array e o raymarch descarta
// os segmentos que caem dentro de qualquer lasso. N lassos, acumulativos.
//
// O QUE FALTA:
//   - undo/redo: a primitiva (LASSO_REMOVED, por id) já existe no redux, falta
//     o botão na UI e a pilha/cursor;
//   - modo keep-inside (crop), o inverso do remove-inside de hoje;
//   - normal analítica da parede do corte: o gradiente ainda lê dados de DENTRO
//     da região removida, então a parede é sombreada com a normal do tecido;
//   - skip-map ciente do lasso: hoje o ESS continua correto (só pula o que é
//     comprovadamente vazio) mas não ganha nada com o corte.
export class RaycastLassoWorld extends World {
    private mainPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;
    private width!: number;
    private height!: number;
    public meshes: Mesh[] = [];
    private camera!: Node;
    //debug PiP (canto inferior): os cubos dos chunks mantidos pra CTF atual
    private debugChunksPass!: DebugChunksPass;
    private debugOverlayPass!: DebugChunksOverlayPass;

    //---- Tudo daqui pra baixo nasce na FASE 2 (loadExam), não no createWorld:
    //---- antes da escolha do exame o mundo tem câmera e mais nada. Por isso
    //---- null e não `!` — a ausência é um estado legítimo, não um descuido de
    //---- inicialização, e quem lê tem que checar.
    private material: VolumeRaycastLassoMaterial | null = null;
    //gradiente pré-calculado: o WORLD é dono e o destrói (o material só amostra)
    private gradientTexture: GPUTexture | null = null;
    //refs pro debug pass: o nó do volume (model matrix + mesh do cubo) e a grade
    private volumeNode: Node | null = null;
    private numChunks: [number, number, number] | null = null;
    private chunkCell: [number, number, number] | null = null;
    //Path do exame já carregado OU em voo. É o que torna ensureExamLoaded()
    //idempotente (ela é chamada todo frame pela behaviour).
    private examPath: string | null = null;
    //destroy() já rodou? A carga é async e a troca de mundo não a espera: sem
    //isto, uma carga em voo terminaria criando texturas num mundo morto.
    private disposed = false;
    //O state do último frame que foi DESENHADO. Comparado por referência: o
    //redux só cria objeto novo quando alguma action passou. Ver skipFrame().
    private lastDrawnState: RootState | null = null;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        this.mainPass = new MeshRenderPass(this.device, canvasFormat);
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
        //passes de DEBUG do ESS: os cubos num offscreen + o overlay no canto
        this.debugChunksPass = new DebugChunksPass(this.device, canvasFormat);
        this.debugOverlayPass = new DebugChunksOverlayPass(this.device, canvas, canvasFormat);
    }

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        //Câmera orbital (mesma OrbitCameraBehaviour do baseline, lê a órbita do
        //redux — a UI de captura de mouse é do App).
        this.camera = new Node();
        this.camera.name = "Camera";
        const camera = new Camera();
        camera.aspect = perspective.aspect;
        camera.fovY = perspective.fovy;
        camera.near = perspective.near;
        camera.far = perspective.far;
        this.camera.camera = camera;
        this.rootNode.addChild(this.camera);
        this.camera.addBehaviour(new OrbitCameraBehaviour(vec3.create(0, 0, 0)));

        this.root.addBehaviour(new FramebufferResizerBehaviour());
        //Quem MEXE na escala quando o fps cai; a de cima é quem a APLICA. As
        //duas conversam pelo redux, não entre si.
        this.root.addBehaviour(new FramebufferAutoScaleBehaviour());

        //E só. O VOLUME não nasce aqui: quem o monta é loadExam(), depois que o
        //usuário escolher o exame no modal. Esta behaviour é quem gateia isso.
        this.root.addBehaviour(new ExamSelectionBehaviour());
    }

    /**
     * Garante que `path` é o exame carregado. Idempotente: a
     * ExamSelectionBehaviour chama todo frame, e só a PRIMEIRA chamada com um
     * path novo dispara a carga.
     */
    public ensureExamLoaded(path: string): void {
        if (this.examPath === path) {
            return;
        }
        this.examPath = path;
        void this.loadExam(path);
    }

    /**
     * FASE 2 da criação do mundo: monta o volume renderer inteiro (textura 3D,
     * gradiente, ocupação dos chunks, material, cubo-proxy e o cérebro) a
     * partir do exame escolhido.
     *
     * Estava tudo dentro do createWorld com um VOLUME_URL fixo. Saiu de lá
     * porque a escolha do exame NÃO PODE ser esperada no createWorld: na troca
     * de mundo o main só chama setUiWorld(mundoNovo) depois do await dele (ver
     * main.ts), então a UI ainda estaria apontada pro mundo anterior — o modal
     * nunca renderizaria e a tela de carga, que só o 1º update() baixa, ficaria
     * de pé pra sempre. Deadlock. Aqui o mundo já está vivo e rodando frames.
     *
     * Levanta a tela de carga da app (a mesma do boot de qualquer mundo): a
     * carga é longa (centenas de MB de fatias) e nada pode ser clicado no meio.
     *
     * NÃO troca de exame com um já montado: hoje ninguém chama isso duas vezes
     * (o modal só aparece sem exame carregado). Quando o botão de "trocar
     * exame" existir, ele precisa antes destruir material/gradiente e tirar o
     * nó do cubo da cena — senão vaza a GPU inteira do exame anterior.
     */
    private async loadExam(path: string): Promise<void> {
        store.dispatch(examLoadStarted());
        store.dispatch(showLoadingScreen());
        try {
            await this.buildVolume(path);
            if (this.disposed) {
                return;
            }
            store.dispatch(examLoadFinished());
        } catch (e) {
            console.error("RaycastLassoWorld: falha carregando o exame", path, e);
            //Solta o path pra reescolher O MESMO exame poder tentar de novo.
            this.examPath = null;
            if (!this.disposed) {
                store.dispatch(examLoadFailed((e as Error).message));
            }
        } finally {
            //Só se o mundo ainda for o vivo: trocar de mundo no meio da carga
            //destrói este, e o mundo NOVO já levantou a tela de carga dele no
            //ctor — baixá-la aqui apagaria a tela de outro (quem a baixa é o
            //1º update() dele, ver world.ts).
            if (!this.disposed) {
                store.dispatch(hideLoadingScreen());
            }
        }
    }

    /** O corpo da fase 2. Separado do loadExam pra ele ficar só com o
     *  protocolo (flags do redux, tela de carga, erro). */
    private async buildVolume(volumeUrl: string): Promise<void> {
        //Volume 3D (HU r16float) + metadata do exame.
        const { texture, metadata } = await loadVolumeTexture(this.device, volumeUrl);
        //A troca de mundo não espera esta carga: se ela aconteceu no meio, o
        //mundo já foi destruído e o que sobrou é lixo de GPU a recolher aqui —
        //ninguém mais tem referência pra isso.
        if (this.disposed) {
            texture.destroy();
            return;
        }
        //Faixa de HU do exame → redux, pro editor de CTF usar como eixo X.
        store.dispatch(setCtfHuRange(metadata.huMin, metadata.huMax));
        //Janela do DICOM: âncora dos presets de MR (ver ctfPresets.ts). Tag
        //opcional e às vezes multivalor — dicomTagNumber pega o 1º valor e
        //devolve NaN se faltar; largura <= 0 avisa o preset que não há janela.
        const windowWidth = dicomTagNumber(metadata.windowWidth, 0);
        store.dispatch(setCtfWindow(
            dicomTagNumber(metadata.windowCenter, 0),
            Number.isFinite(windowWidth) ? windowWidth : 0,
        ));
        //Gradiente pré-calculado (mesmo compute do mundo CT).
        const gradientParams = gradientParamsFromMetadata(metadata);
        const gradientTexture = createGradientTexture(this.device, texture, gradientParams);

        //ESS: carrega os histogramas de chunk e os reduz à ocupação estática
        //(1 u32/chunk). É intrínseco do volume — carregado uma vez aqui.
        const occupancy = await loadChunkOccupancy(volumeUrl, metadata);
        if (this.disposed) {
            texture.destroy();
            gradientTexture.destroy();
            return;
        }

        const initialCtf = store.getState().ctf.points;
        //Local, e só no fim vira this.material: enquanto a montagem não fecha,
        //o campo do mundo continua null e o render() (que roda ENTRE os awaits
        //daqui) enxerga "sem volume", não um material meio-montado.
        const material = new VolumeRaycastLassoMaterial(
            this.device,
            texture,
            gradientTexture,
            gradientParams.spacing,
            initialCtf,
            {
                numChunksX: metadata.numChunksX,
                numChunksY: metadata.numChunksY,
                numChunksZ: metadata.numChunksZ,
                totalChunks: metadata.totalChunks,
                chunkSize: metadata.chunkSize,
            },
            store.getState().textureBasedCT.alphaScale,
            store.getState().raycast.gradientEnabled,
            store.getState().raycast.gradientMode === "on-the-fly" ? 1 : 0,
            store.getState().raycast.essEnabled,
        );
        //Grade de chunks no espaço local, usada pelo skip-map e pelo PiP de
        //debug. Calculada antes do skip-map inicial porque ele já precisa dela.
        const numChunks: [number, number, number] =
            [metadata.numChunksX, metadata.numChunksY, metadata.numChunksZ];
        const chunkCell: [number, number, number] = [
            metadata.chunkSize / metadata.width,
            metadata.chunkSize / metadata.height,
            metadata.chunkSize / metadata.numSlices,
        ];
        //skip-map INICIAL: o world calcula a partir da CTF corrente E dos lassos
        //que sobreviveram à troca de mundo (a behaviour só recalcula em
        //MUDANÇAS, então o 1º frame já precisa estar certo).
        material.setSkipMap(skipMapWithLassos(
            occupancy,
            initialCtf,
            metadata.histogramBins,
            metadata.histogramMin,
            metadata.histogramMax,
            store.getState().lasso.items,
            { numChunks, chunkCell },
            new LassoSatCache(),
        ));
        //Lassos INICIAIS: a lista sobrevive à troca de mundo (é o documento do
        //usuário, não o modo de interação), então sair daqui e voltar tem que
        //reencontrar os recortes. A behaviour só reage a MUDANÇAS — o estado
        //de partida é do world, mesmo padrão do skip-map acima.
        material.setLassos(store.getState().lasso.items);
        material.setLassoDebug(store.getState().raycast.lassoDebugView);
        material.setScalpels(store.getState().scalpel.items);
        material.setScalpelDebug(store.getState().raycast.scalpelDebugView);

        //O proxy: o cubo unitário [-0.5,0.5]³ = a caixa do volume.
        const cube = await loadGltf(this.device, "/models/unitary_cube.glb");
        if (this.disposed) {
            material.destroy();
            gradientTexture.destroy();
            cube.meshes.forEach(m => m.destroy());
            return;
        }
        this.meshes.push(...cube.meshes);
        cube.roots.forEach(r => this.rootNode.addChild(r));
        const volumeNode = cube.nodes.find(n => n.renderable);
        if (!volumeNode || !volumeNode.renderable) {
            throw new Error("RaycastLassoWorld: unitary_cube.glb sem renderable.");
        }
        volumeNode.name = "Volume";
        volumeNode.renderable.material = material;
        //refs pro debug pass: model matrix + mesh do cubo saem daqui; a grade e o
        //tamanho do chunk em uvw (chunkSize/dims por eixo) do metadata.
        this.volumeNode = volumeNode;

        //Proporções físicas do exame (voxel de CT é anisotrópico), normalizadas
        //pro maior eixo = 1 — mesmo cálculo do baseline.
        const physX = metadata.width * dicomTagNumber(metadata.pixelSpacing, 1);
        const physY = metadata.height * dicomTagNumber(metadata.pixelSpacing, 0);
        const physZ = metadata.numSlices * sliceSpacingMm(metadata);
        if (Number.isFinite(physX) && Number.isFinite(physY) && Number.isFinite(physZ) && physZ > 0) {
            const longest = Math.max(physX, physY, physZ);
            volumeNode.scale[0] = physX / longest;
            volumeNode.scale[1] = physY / longest;
            volumeNode.scale[2] = physZ / longest;
        }
        //Em pé, de frente: Rx(-90°) põe a cabeça pra cima (mesmo do baseline).
        volumeNode.eulerAngles = new Float32Array([-90, 0, 0]);

        //O cérebro: CTF + alpha + gradiente + skip-map + ESS on/off.
        const brain = new VolumeRaycastLassoBehaviour(
            material,
            occupancy,
            metadata.histogramBins,
            metadata.histogramMin,
            metadata.histogramMax,
            { numChunks, chunkCell },
        );
        brain.node = volumeNode;
        volumeNode.behaviours.push(brain);

        //Só AGORA o mundo passa a ter volume: os campos viram não-null todos
        //juntos, no fim, pra não existir frame com material montado e grade de
        //chunks ainda faltando (o render() do PiP lê os três).
        this.gradientTexture = gradientTexture;
        this.material = material;
        this.numChunks = numChunks;
        this.chunkCell = chunkCell;
    }

    /**
     * A matriz que CONGELA a câmera pra um lasso: leva o ponto do espaço local
     * do volume (o cubo [-0.5,0.5]³ do raymarch) pro clip de agora.
     *
     *     clipFromLocal = proj · view · model
     *
     * view é a inversa da worldMatrix do nó da câmera (mesma conta do
     * MeshRenderPass — a câmera não guarda view, ela vem do nó dono) e model é
     * a worldMatrix do nó do volume. Compor as três AQUI e não no shader deixa
     * o lasso com uma matriz só, e amarra o corte ao volume: girar o nó do
     * volume depois gira a região removida junto.
     *
     * É o canal engine→UI de sempre (o overlay lê o scene graph, como a
     * TerraPositionTable lê a worldMatrix) — nada disso passa pelo redux, que
     * carrega intenção e não estado por-frame. Devolve matriz NOVA a cada
     * chamada: quem pediu vira dono dela e a guarda dentro do LassoData.
     */
    captureClipFromLocal(): Mat4 {
        //Sem volume não há espaço local pra congelar. Não deveria acontecer (a
        //UI de ferramentas só existe com o exame pronto), mas um throw claro
        //aqui é melhor do que uma matriz de lixo virando um corte torto.
        if (this.volumeNode === null) {
            throw new Error("RaycastLassoWorld: captureClipFromLocal() sem exame carregado.");
        }
        const view = mat4.invert(this.camera.worldMatrix);
        const proj = this.camera.camera!.getProjectionMatrix();
        return mat4.multiply(mat4.multiply(proj, view), this.volumeNode.worldMatrix);
    }

    /**
     * Congela o frame enquanto uma ferramenta de corte está armada E o redux
     * não mexeu desde o último frame desenhado.
     *
     * Por que isso é seguro, e não um atalho: com uma ferramenta na mão, o
     * overlay de captura cobre a camada de órbita e come todos os eventos de
     * ponteiro — a câmera NÃO PODE se mover. Nenhuma behaviour deste mundo
     * anima nada por conta própria; tudo que muda a imagem chega por dispatch.
     * E o redux devolve o MESMO objeto de state quando nada foi despachado.
     * Então "state igual + ferramenta armada" é prova de que o frame sairia
     * pixel por pixel idêntico ao anterior.
     *
     * O ganho é no traço: desenhar sobre um volume que custa 60ms de GPU por
     * frame trava o canvas 2D do overlay. Sem o raymarch competindo, o traço
     * fica no ritmo do ponteiro.
     *
     * Fechar um corte é um dispatch, então o frame seguinte roda e o resultado
     * aparece na hora — não é preciso soltar a ferramenta pra ver o que cortou.
     */
    override skipFrame(): boolean {
        const state = store.getState();
        if (state.tools.activeTool === "none") {
            this.lastDrawnState = null;
            return false;
        }
        if (state === this.lastDrawnState) {
            return true;
        }
        //Mudou (ou é o primeiro frame com a ferramenta armada): desenha este e
        //congela a partir do próximo.
        this.lastDrawnState = state;
        return false;
    }

    resizeFramebuffer(factor: number) {
        //Math.floor: factor fracionário não pode virar tamanho de textura
        //fracionário (o baseline ainda não fazia isso — aqui já entra certo).
        this.width = Math.max(1, Math.floor(this.canvas.width * factor));
        this.height = Math.max(1, Math.floor(this.canvas.height * factor));
        this.camera.camera!.aspect = this.width / this.height;
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        const width = this.width;
        const height = this.height;
        this.mainPass.render(encoder, this.rootNode, width, height);
        this.finalPass.render(encoder, this.mainPass.colorView);

        //PiP de debug: cubos dos chunks mantidos, no canto inferior direito.
        //Gateado pelo redux (lido por-frame de propósito: gateia PASSES, não é
        //estado de nó). Renderiza no tamanho CHEIO do canvas (não o escalado do
        //framebufferScale) pra o quadzinho ficar nítido.
        //Sem exame carregado não há chunks a desenhar — o mundo roda frames
        //(câmera viva, modal por cima) desde antes do volume existir.
        if (store.getState().raycast.essDebugView && this.material !== null
            && this.volumeNode !== null && this.numChunks !== null && this.chunkCell !== null) {
            this.debugChunksPass.render(
                encoder,
                this.camera,
                this.volumeNode.worldMatrix,
                this.volumeNode.renderable!.mesh,
                this.material.skipMapBuffer,
                this.numChunks,
                this.chunkCell,
                Math.max(1, Math.round(this.canvas.width * DEBUG_PIP_RES_SCALE)),
                Math.max(1, Math.round(this.canvas.height * DEBUG_PIP_RES_SCALE)),
            );
            this.debugOverlayPass.render(encoder, this.debugChunksPass.colorView);
        }
    }

    override destroy(): void {
        //Marca ANTES de qualquer coisa: uma carga de exame em voo checa isto
        //depois de cada await e se recolhe sozinha (ver buildVolume).
        this.disposed = true;
        super.destroy(); //materiais registrados (nenhum aqui)
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        //null quando o mundo morre antes de escolherem exame — sair pelo
        //WorldSwitch com o modal aberto é um caminho normal, não um erro.
        this.material?.destroy(); //volume + preint + params + skip-map
        this.gradientTexture?.destroy(); //do world (o material só a amostra)
        this.mainPass.destroy();
        this.finalPass.destroy();
        this.debugChunksPass.destroy();
        this.debugOverlayPass.destroy();
    }
}
