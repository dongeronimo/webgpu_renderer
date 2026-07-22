//O CÉREBRO da fumaça, como Behaviour. O node ao qual esta behaviour está
//anexada é a ORIGEM do volume: a posição (translação) do node ancora onde a
//fumaça é simulada/desenhada. Sem rotação/escala não-uniforme por hora — a
//gente continua pensando em AABB (o proxy é o cubo do node, escala = tamanho
//do volume).
//
//LOCOMOTIVA: como a sim vive no referencial LOCAL da caixa, se o node andar a
//fumaça andaria grudada nele. Pra o RASTRO, a behaviour deriva a velocidade do
//próprio node (delta de posição / dt), converte pra células/segundo e injeta
//como frameVel (o solver subtrai do transporte → o conteúdo deriva pra trás).
//A dissipação de massa (AdvectionSim.dissipationRate) mantém a fumaça em regime
//estável em vez de acumular no rastro.
//
//OBSTÁCULOS: re-voxelizados a cada `revoxelizeInterval` frames (não todo frame
//— é O(N³) + upload), e só os que estão a até `obstacleRange` do volume
//(broad-phase por distância). AABBs muito retangulares "vazam" — compromisso
//aceito; o certo seria colliders de verdade, mais pra frente.
//
//Ciclo de vida: start() aloca a AdvectionSim; simulate() roda um passo (chamado
//pelo SmokeVolumePass, dono do encoder); dispose() libera a GPU. Device vem no
//construtor porque World.device é `protected`.
import { Behaviour } from "../behaviour";
import { AdvectionSim } from "./advectionCompute";
import type { Node } from "../node";

export interface SmokeConfig {
    /** Resolução do grid do fluido (default 96). */
    grid?: number;
    /** Velocidade do updraft contínuo, em células/segundo (default 20). */
    plumeSpeed?: number;
    /** Taxa de emissão de densidade (default = da AdvectionSim). */
    densityRate?: number;
    /** Iterações de Jacobi da projeção (default = da AdvectionSim). */
    jacobiIterations?: number;
    /** Dissipação de massa por segundo (default = da AdvectionSim). */
    dissipationRate?: number;
    /** Centro do emissor, FRAÇÃO do volume em [0,1]³ (default bottom-center). */
    emitCenter?: [number, number, number];
    /** Raio do emissor, fração do grid (default 0.1). */
    emitRadius?: number;
    /** Re-voxeliza os obstáculos a cada N frames (default 15). */
    revoxelizeInterval?: number;
    /** Broad-phase: só voxeliza sólidos a até esta distância (mundo) do volume. */
    obstacleRange?: number;
}

/** Uma fonte de fumaça na árvore: o node (transform/proxy) + o cérebro. */
export interface SmokeSource {
    node: Node;
    behaviour: SmokeBehaviour;
}

/**
 * Coleta da árvore os nodes com SmokeBehaviour (e um Renderable = o cubo
 * proxy). Função livre porque TRÊS passes consomem a mesma lista no frame:
 * a simulação (compute), a transmitância em light-space e o render do volume.
 */
export function collectSmokeSources(root: Node): SmokeSource[] {
    const out: SmokeSource[] = [];
    const visit = (n: Node) => {
        const b = n.behaviours.find(x => x instanceof SmokeBehaviour) as SmokeBehaviour | undefined;
        if (b && n.renderable) {
            out.push({ node: n, behaviour: b });
        }
        for (const c of n.children) {
            visit(c);
        }
    };
    visit(root);
    return out;
}

export class SmokeBehaviour extends Behaviour {
    private readonly device: GPUDevice;
    private readonly grid: number;
    private readonly plumeSpeed: number;
    private readonly densityRate?: number;
    private readonly jacobiIterations?: number;
    private readonly dissipationRate?: number;
    private readonly emitCenterFrac: [number, number, number];
    private readonly emitRadiusFrac: number;
    private readonly revoxelizeInterval: number;
    private readonly obstacleRange: number;

    private sim: AdvectionSim | null = null;
    private dt = 0;
    //Velocidade do volume no frame atual (células/s) — o rastro da locomotiva.
    private frameVel: [number, number, number] = [0, 0, 0];
    //Posição de mundo do frame anterior (pra derivar a velocidade).
    private lastPos: [number, number, number] | null = null;
    //Contador de frames pro throttle da re-voxelização.
    private frameCount = 0;
    //Sólidos que o fluido colide (voxelizados relativo ao volume DESTE node).
    private obstacleNodes: Node[] = [];

    constructor(device: GPUDevice, config: SmokeConfig = {}) {
        super();
        this.device = device;
        this.grid = config.grid ?? 96;
        this.plumeSpeed = config.plumeSpeed ?? 20;
        this.densityRate = config.densityRate;
        this.jacobiIterations = config.jacobiIterations;
        this.dissipationRate = config.dissipationRate;
        this.emitCenterFrac = config.emitCenter ?? [0.5, 0.12, 0.5];
        this.emitRadiusFrac = config.emitRadius ?? 0.1;
        this.revoxelizeInterval = Math.max(1, config.revoxelizeInterval ?? 15);
        this.obstacleRange = config.obstacleRange ?? 0.5;
    }

    /** Registra os nodes sólidos que a fumaça contorna. Só armazena — a
     *  voxelização acontece no update (throttled + broad-phase). Chame no createWorld. */
    setObstacleNodes(nodes: Node[]): void {
        this.obstacleNodes = nodes;
        this.frameCount = 0; //re-voxeliza já no próximo update
    }

    override start(): void {
        this.sim = new AdvectionSim(this.device, this.grid);
        if (this.densityRate !== undefined) this.sim.densityRate = this.densityRate;
        if (this.jacobiIterations !== undefined) this.sim.jacobiIterations = this.jacobiIterations;
        if (this.dissipationRate !== undefined) this.sim.dissipationRate = this.dissipationRate;
        this.sim.emitCenter = [
            this.emitCenterFrac[0] * this.grid,
            this.emitCenterFrac[1] * this.grid,
            this.emitCenterFrac[2] * this.grid,
        ];
        this.sim.emitRadius = this.emitRadiusFrac * this.grid;
    }

    update(deltaTime: number): void {
        this.dt = deltaTime;
        if (!this.sim) return;

        //Matriz de mundo FRESCA (no update a cacheada ainda é a do frame anterior).
        const vm = this.node.getWorldMatrix();
        const pos: [number, number, number] = [vm[12], vm[13], vm[14]];
        //Tamanho do volume por eixo = comprimento das colunas da base (sem
        //rotação isso É a escala). Serve pra converter mundo↔célula.
        const size: [number, number, number] = [
            Math.hypot(vm[0], vm[1], vm[2]),
            Math.hypot(vm[4], vm[5], vm[6]),
            Math.hypot(vm[8], vm[9], vm[10]),
        ];

        //Velocidade da caixa em CÉLULAS/s (mundo/s × células por unidade de mundo).
        if (this.lastPos && deltaTime > 0) {
            this.frameVel = [
                ((pos[0] - this.lastPos[0]) / deltaTime) * this.grid / size[0],
                ((pos[1] - this.lastPos[1]) / deltaTime) * this.grid / size[1],
                ((pos[2] - this.lastPos[2]) / deltaTime) * this.grid / size[2],
            ];
        } else {
            this.frameVel = [0, 0, 0];
        }
        this.lastPos = pos;

        //Re-voxeliza a cada N frames (throttle). Sem obstáculos → nada a fazer.
        if (this.obstacleNodes.length > 0 && this.frameCount % this.revoxelizeInterval === 0) {
            this.revoxelize(pos, size);
        }
        this.frameCount++;
    }

    /** Roda um passo do solver. Chamado pelo render pass (dono do encoder). */
    simulate(encoder: GPUCommandEncoder): void {
        if (!this.sim) return;
        this.sim.step(encoder, this.dt, [0, this.plumeSpeed, 0], this.frameVel);
    }

    /** Densidade mais recente — o SmokeVolumePass amostra isto. */
    get densityView(): GPUTextureView {
        return this.sim!.densityView;
    }

    override dispose(): void {
        this.sim?.destroy();
        this.sim = null;
    }

    /**
     * Voxeliza os obstáculos PRÓXIMOS na máscara. Broad-phase: só entra o sólido
     * cujo AABB de mundo intersecta o AABB do volume dilatado por `obstacleRange`.
     * O mapeamento mundo→célula é relativo à origem (pos) + tamanho (size) do
     * volume — por isso re-roda quando o volume se move.
     */
    private revoxelize(pos: [number, number, number], size: [number, number, number]): void {
        if (!this.sim) return;
        const r = this.obstacleRange;
        const volMin = [pos[0] - size[0] * 0.5 - r, pos[1] - size[1] * 0.5 - r, pos[2] - size[2] * 0.5 - r];
        const volMax = [pos[0] + size[0] * 0.5 + r, pos[1] + size[1] * 0.5 + r, pos[2] + size[2] * 0.5 + r];
        const N = this.grid;
        const toCell = (w: Float32Array, i: number) => ((w[i] - pos[i]) / size[i] + 0.5) * N;

        const boxes: { min: [number, number, number]; max: [number, number, number] }[] = [];
        for (const n of this.obstacleNodes) {
            if (!n.renderable) continue;
            const aabb = n.renderable.worldAABB(n.getWorldMatrix());
            //Broad-phase: descarta o que está fora do alcance (sem sobreposição de AABB).
            if (aabb.max[0] < volMin[0] || aabb.min[0] > volMax[0]
                || aabb.max[1] < volMin[1] || aabb.min[1] > volMax[1]
                || aabb.max[2] < volMin[2] || aabb.min[2] > volMax[2]) {
                continue;
            }
            boxes.push({
                min: [toCell(aabb.min, 0), toCell(aabb.min, 1), toCell(aabb.min, 2)],
                max: [toCell(aabb.max, 0), toCell(aabb.max, 1), toCell(aabb.max, 2)],
            });
        }
        this.sim.setObstacles(boxes);
    }
}
