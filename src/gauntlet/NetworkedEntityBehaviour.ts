import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { AnimatorBehaviour } from "../skinning/AnimatorBehaviour";
import type GauntletNetworkBehaviour from "./GauntletNetwork";

//yaw chega do server em RADIANOS (Math.atan2 java); node.eulerAngles do
//client quer GRAUS — mesma conversão duplicada em GauntletNetwork.ts e
//MineAvatarBehaviour.ts (de propósito, ver nota lá).
const RAD_TO_DEG = 180 / Math.PI;

//Fração do erro (predição local ou dead reckoning) corrigida a CADA snap
//(20 Hz), em vez de teleportar pro valor do server. Sem rewind/replay de
//input — um puxão pequeno a cada 50ms é imperceptível.
const SNAP_BLEND = 0.35;

//lerp de ângulo em GRAUS pelo caminho mais curto — evita girar 350° quando
//o alvo tá a 10° de distância do outro lado da costura -180/180.
function lerpAngleDeg(fromDeg: number, toDeg: number, t: number): number {
    const delta = (((toDeg - fromDeg + 180) % 360 + 360) % 360) - 180;
    return fromDeg + delta * t;
}

/**
 * Anexada em TODO pawn nascido de uma entidade do server (player hoje;
 * monstro/tesouro amanhã têm a mesma necessidade) — reconciliação de
 * posição/yaw com o snap e dead reckoning entre snaps são propriedades de
 * "entidade sincronizada pela rede", não de "é um player". `MineAvatarBehaviour`
 * é o complemento, adicionado só na entidade que é MINHA, e cobre só o que é
 * específico dela: ler input e prever localmente.
 *
 * `locallyPredicted` desliga o dead reckoning do update(): a entidade local
 * já é movida todo frame pela própria predição (a partir do input real), e
 * rodar as duas ao mesmo tempo duplicaria o deslocamento. O blend do
 * applySnap continua rodando pra ela também — é o que corrige o resíduo entre
 * a predição local e a verdade do server.
 */
export default class NetworkedEntityBehaviour extends Behaviour {
    private readonly network: GauntletNetworkBehaviour;
    private readonly locallyPredicted: boolean;
    //última vx,vz conhecida (CÉLULAS/s, espaço do server), pro dead
    //reckoning entre snaps. Não usada quando locallyPredicted.
    private velX = 0;
    private velZ = 0;
    //sem snap ainda, não há velocidade confiável pra extrapolar
    private hasSnapped = false;
    //AnimatorBehaviour do filho (o armature fabricado pelo prefab) — achada
    //uma vez no start(), null se o prefab não tiver uma (ex.: tesouro sem
    //skin). Ver skinning/AnimatorBehaviour.playState.
    private animator: AnimatorBehaviour | null = null;

    constructor(network: GauntletNetworkBehaviour, locallyPredicted: boolean) {
        super();
        this.network = network;
        this.locallyPredicted = locallyPredicted;
    }

    override start(): void {
        for (const child of this.node.children) {
            const found = child.behaviours.find((b): b is AnimatorBehaviour => b instanceof AnimatorBehaviour);
            if (found) {
                this.animator = found;
                break;
            }
        }
    }

    /** Chamado pela GauntletNetworkBehaviour a cada snap que menciona esta
     *  entidade. Puxa posição/yaw uma FRAÇÃO rumo ao valor do server (blend,
     *  não teleporte), guarda a velocidade corrente pro dead reckoning, e
     *  troca a animação se o `state` do server mudou (ex.: "idle"→"walk"). */
    applySnap(xCells: number, zCells: number, yawRad: number, vx: number, vz: number, state?: string): void {
        const targetX = this.network.serverToWorldX(xCells);
        const targetZ = this.network.serverToWorldZ(zCells);
        this.node.position[0] += (targetX - this.node.position[0]) * SNAP_BLEND;
        this.node.position[2] += (targetZ - this.node.position[2]) * SNAP_BLEND;
        const targetYawDeg = yawRad * RAD_TO_DEG;
        this.node.eulerAngles = vec3.create(0, lerpAngleDeg(this.node.eulerAngles[1], targetYawDeg, SNAP_BLEND), 0);
        this.velX = vx;
        this.velZ = vz;
        this.hasSnapped = true;
        if (state !== undefined) {
            this.animator?.playState(state);
        }
    }

    //Dead reckoning: entre snaps (50ms a 20Hz), extrapola pela última
    //velocidade conhecida — sem isso o movimento só "pula" a cada snap.
    update(deltaTime: number): void {
        if (this.locallyPredicted || !this.hasSnapped) return;
        const [dx, dz] = this.network.cellsToWorldDelta(this.velX * deltaTime, this.velZ * deltaTime);
        this.node.position[0] += dx;
        this.node.position[2] += dz;
    }
}
