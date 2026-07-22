import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import type GauntletNetworkBehaviour from "./GauntletNetwork";

//Mesma taxa do tick do server (20 Hz) — manda SEMPRE, mesmo sem tecla
//apertada: o server usa a última intenção recebida como corrente (spec
//"input, não posição"). Subtrai o intervalo em vez de zerar o acumulador:
//não dá drift se um frame atrasar um pouco.
const INPUT_INTERVAL_SECONDS = 1 / 20;

const RAD_TO_DEG = 180 / Math.PI;

/** Anda `current` até `target`, no máximo `maxDelta` por chamada — mesma
 *  função do server (GameLoop.moveToward), pra acelerar/frear igual. */
function moveToward(current: number, target: number, maxDelta: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
}

/**
 * Anexada só no PIVOT do PRÓPRIO player (owner === myId). Lê teclado, prediz
 * o movimento localmente TODO FRAME (mesma regra de aceleração/giro/colisão
 * do server — ver GameLoop.stepMovement) e manda a intenção crua pro server
 * a 20Hz. A predição responde na hora ao input, inclusive parede: sem
 * checar colisão aqui, o pawn local "afundava" visualmente na parede a cada
 * frame e o snap puxava de volta a cada 50ms — o tremor rápido relatado.
 * Quando o snap do próprio pawn chega, o GauntletNetwork só corrige por
 * blend em vez de substituir — sem rewind/replay de input.
 */
export default class MineAvatarBehaviour extends Behaviour {
    private readonly network: GauntletNetworkBehaviour;
    private accumSeconds = 0;
    private readonly keysDown = new Set<string>();
    private readonly onKeyDown = (e: KeyboardEvent) => this.keysDown.add(e.code);
    private readonly onKeyUp = (e: KeyboardEvent) => this.keysDown.delete(e.code);
    //velocidade PREDITA local, em células/s (mesmo espaço do server) — só
    //convertida pra unidades-mundo na hora de mover o pivot.
    private velX = 0;
    private velZ = 0;

    constructor(network: GauntletNetworkBehaviour) {
        super();
        this.network = network;
    }

    start(): void {
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
    }

    dispose(): void {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
    }

    //turn: gira o pawn (A=+1/D=-1) — sinal é um CHUTE a partir da convenção
    //"dz negativo = norte" (ver comentário do forward em update()); se A/D
    //girarem pro lado errado na tela, inverte o sinal AQUI e em
    //GameLoop.stepMovement junto (mesmo cuidado do W abaixo).
    //move: anda na direção que o pawn ESTÁ olhando (W=+1 pra frente,
    //S=-1 pra trás) — se W andar pra trás na demo, é só inverter os sinais.
    private currentIntent(): [number, number] {
        let turn = 0;
        let move = 0;
        if (this.keysDown.has("KeyA") || this.keysDown.has("ArrowLeft")) turn += 1;
        if (this.keysDown.has("KeyD") || this.keysDown.has("ArrowRight")) turn -= 1;
        if (this.keysDown.has("KeyW") || this.keysDown.has("ArrowUp")) move += 1;
        if (this.keysDown.has("KeyS") || this.keysDown.has("ArrowDown")) move -= 1;
        return [turn, move];
    }

    update(deltaTime: number): void {
        const [turn, move] = this.currentIntent();

        //---- yaw: agora é ESTADO PERSISTENTE, girado por A/D a ritmo
        //constante — funciona parado (turn independe de move). Valores vêm
        //de GauntletNetwork (buscados via GET /api/player-controller-settings/{character}
        //em connectSignaling(), ANTES de qualquer pawn nascer — ver lá).
        //Parado (move===0, SEM intenção de andar) gira idleTurnMultiplier×
        //mais rápido — mesma regra e MESMA decisão pela intenção crua (não
        //pela velocidade residual) que GameLoop.stepMovement no server.
        if (turn !== 0) {
            const turnRateDegPerSec = move === 0
                ? this.network.angularVelocityDegPerSec * this.network.idleTurnMultiplier
                : this.network.angularVelocityDegPerSec;
            const newYawDeg = this.node.eulerAngles[1] + turn * turnRateDegPerSec * deltaTime;
            this.node.eulerAngles = vec3.create(0, newYawDeg, 0);
        }

        //---- vetor forward a partir do yaw CORRENTE — mesma convenção do
        //antigo atan2(dx,dz)==yaw (dx=sin(yaw), dz=cos(yaw)), só que agora
        //indo do ângulo pro vetor. W(move=+1) anda nele, S(move=-1) anda no
        //oposto, sem virar o pawn.
        const yawRad = this.node.eulerAngles[1] / RAD_TO_DEG;
        const forwardX = Math.sin(yawRad);
        const forwardZ = Math.cos(yawRad);

        //---- predição local: mesma regra de aceleração do server, rodando a
        //CADA FRAME (não só nos 20Hz do envio) — desliza suave até o alvo em
        //vez de saltar direto pra ele. move>=0 (W ou parado) usa a velocidade
        //de frente, move<0 (S) usa a de trás (mais lenta) — espelha
        //GameLoop.stepMovement.
        const moveSpeed = move >= 0 ? this.network.moveSpeedForward : this.network.moveSpeedBackward;
        const targetVelX = forwardX * move * moveSpeed;
        const targetVelZ = forwardZ * move * moveSpeed;
        const maxDelta = this.network.accel * deltaTime;
        this.velX = moveToward(this.velX, targetVelX, maxDelta);
        this.velZ = moveToward(this.velZ, targetVelZ, maxDelta);

        if (Math.hypot(this.velX, this.velZ) > 1e-6) {
            //Tudo em CÉLULAS, espelhando GameLoop.stepMovement 1:1 (mesmo
            //isFreeAtCells que o server usa) — é o que evita prever um passo
            //que o server vai rejeitar.
            const curX = this.network.worldToCellX(this.node.position[0]);
            const curZ = this.network.worldToCellZ(this.node.position[2]);
            const wantX = curX + this.velX * deltaTime;
            const wantZ = curZ + this.velZ * deltaTime;

            let finalX = curX;
            if (this.network.isFreeAtCells(wantX, curZ)) {
                finalX = wantX;
            } else {
                this.velX = 0;
            }
            let finalZ = curZ;
            if (this.network.isFreeAtCells(finalX, wantZ)) {
                finalZ = wantZ;
            } else {
                this.velZ = 0;
            }

            this.node.position[0] = this.network.serverToWorldX(finalX);
            this.node.position[2] = this.network.serverToWorldZ(finalZ);
        }

        //---- envio pro server: só a 20Hz — manda a intenção CRUA (turn,move);
        //o server tem sua PRÓPRIA cópia de MOVE_SPEED/ACCEL/TURN_RATE e roda a
        //mesma simulação (spec: "input, não posição" — nunca a predição local).
        this.accumSeconds += deltaTime;
        if (this.accumSeconds < INPUT_INTERVAL_SECONDS) return;
        this.accumSeconds -= INPUT_INTERVAL_SECONDS;
        this.network.sendInput(turn, move);
    }
}
