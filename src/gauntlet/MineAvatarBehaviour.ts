import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import type GauntletNetworkBehaviour from "./GauntletNetwork";

//Mesma taxa do tick do server (20 Hz) — manda SEMPRE, mesmo sem tecla
//apertada: o server usa a última intenção recebida como corrente (spec
//"input, não posição"). Subtrai o intervalo em vez de zerar o acumulador:
//não dá drift se um frame atrasar um pouco.
const INPUT_INTERVAL_SECONDS = 1 / 20;

//Espelham GameLoop.java (MOVE_SPEED/ACCEL/TURN_RATE) — a predição local só
//fica parecida com o que o server vai devolver se rodar a MESMA regra de
//movimento. Não precisa ser bit-exato: o snap corrige o resto por blend
//(ver GauntletNetwork.SNAP_BLEND). Se a sensação mudar no server, mudar aqui
//também.
const MOVE_SPEED = 3.0;
const ACCEL = 20.0;
const TURN_RATE_DEG_PER_SEC = 540.0;
const RAD_TO_DEG = 180 / Math.PI;

/** Anda `current` até `target`, no máximo `maxDelta` por chamada — mesma
 *  função do server (GameLoop.moveToward), pra acelerar/frear igual. */
function moveToward(current: number, target: number, maxDelta: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
}

/** Gira `currentDeg` rumo a `targetDeg` pelo caminho mais curto, no máximo
 *  `maxDeltaDeg` por chamada — mesma função do server (GameLoop.rotateToward). */
function rotateTowardDeg(currentDeg: number, targetDeg: number, maxDeltaDeg: number): number {
    const delta = (((targetDeg - currentDeg + 180) % 360 + 360) % 360) - 180;
    if (Math.abs(delta) <= maxDeltaDeg) return currentDeg + delta;
    return currentDeg + Math.sign(delta) * maxDeltaDeg;
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

    //dz negativo = norte (longe da câmera, ver serverToWorldZ/onMapSync);
    //se W andar pra trás na demo, é só inverter os sinais aqui.
    private currentIntent(): [number, number] {
        let dx = 0;
        let dz = 0;
        if (this.keysDown.has("KeyW") || this.keysDown.has("ArrowUp")) dz -= 1;
        if (this.keysDown.has("KeyS") || this.keysDown.has("ArrowDown")) dz += 1;
        if (this.keysDown.has("KeyD") || this.keysDown.has("ArrowRight")) dx += 1;
        if (this.keysDown.has("KeyA") || this.keysDown.has("ArrowLeft")) dx -= 1;
        return [dx, dz];
    }

    update(deltaTime: number): void {
        const [dx, dz] = this.currentIntent();
        const mag = Math.hypot(dx, dz);

        //---- yaw: gira rumo ao INPUT (não à velocidade), taxa limitada — já
        //começa a virar mesmo ainda freando da direção anterior, em vez de
        //ficar preso no ângulo antigo até a velocidade cruzar zero e aí
        //saltar instantâneo pro oposto. Parado (sem intent): não vira.
        if (mag > 1e-6) {
            const targetYawDeg = Math.atan2(dx, dz) * RAD_TO_DEG;
            const maxTurnDeg = TURN_RATE_DEG_PER_SEC * deltaTime;
            this.node.eulerAngles = vec3.create(
                0,
                rotateTowardDeg(this.node.eulerAngles[1], targetYawDeg, maxTurnDeg),
                0,
            );
        }

        //---- predição local: mesma regra de aceleração do server, rodando a
        //CADA FRAME (não só nos 20Hz do envio) — desliza suave até o alvo em
        //vez de saltar entre as 8 direções.
        const targetVelX = mag > 1e-6 ? (dx / mag) * MOVE_SPEED : 0;
        const targetVelZ = mag > 1e-6 ? (dz / mag) * MOVE_SPEED : 0;
        const maxDelta = ACCEL * deltaTime;
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

        //---- envio pro server: só a 20Hz — manda a intenção CRUA (dx,dz); o
        //server tem sua PRÓPRIA cópia de MOVE_SPEED/ACCEL/TURN_RATE e roda a
        //mesma simulação (spec: "input, não posição" — nunca a predição local).
        this.accumSeconds += deltaTime;
        if (this.accumSeconds < INPUT_INTERVAL_SECONDS) return;
        this.accumSeconds -= INPUT_INTERVAL_SECONDS;
        this.network.sendInput(dx, dz);
    }
}
