import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { AnimatorBehaviour } from "../skinning/AnimatorBehaviour";
import type GauntletNetworkBehaviour from "./GauntletNetwork";

//Passo FIXO da simulação local = tick do server (20 Hz). A predição avança
//SÓ em múltiplos disto, com a MESMA conta do server (uma integração de DT por
//passo), então a trajetória prevista bate float-a-float com a autoritativa e o
//reconcile não fica injetando erro todo snap (era isso que tremia). É também a
//taxa de envio de input: um input por passo fixo = ~um por tick do server.
const FIXED_DT = 1 / 20;

//Teto de passos por frame: se o frame atrasar MUITO (aba em background, GC),
//não ressimula meio segundo de golpe nem despeja um monte de input — descarta
//o excesso acumulado. Anti "spiral of death".
const MAX_STEPS_PER_FRAME = 5;

const RAD_TO_DEG = 180 / Math.PI;

//Quão rápido o offset VISUAL da correção decai a zero (1/s). O sim é corrigido
//na hora (posição autoritativa); só o que aparece na tela chega lá suave, com
//const de tempo ~1/12s ≈ 83ms. Maior = corrige mais rápido/mais seco. Com o
//passo fixo o erro de reconcile ficou minúsculo (só misprediction real, tipo
//parede), então isto quase nunca tem trabalho — é rede de segurança agora.
const CORRECTION_SMOOTH_RATE = 12;

//Teto do histórico (~3s a 20Hz): seguro contra crescer sem limite se os acks
//pararem de chegar (socket travado). O ack normalmente poda bem antes disso.
const HISTORY_MAX = 60;

/** Anda `current` até `target`, no máximo `maxDelta` por chamada — mesma
 *  função do server (GameLoop.moveToward), pra acelerar/frear igual. */
function moveToward(current: number, target: number, maxDelta: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
}

/** Menor delta angular (graus) de `fromDeg` a `toDeg`, em (-180,180] — pra a
 *  correção de yaw não girar pelo lado longo perto da costura -180/180 e pra
 *  comparar contra um simYawDeg não-normalizado (que pode ter dado voltas). */
function shortestDeltaDeg(fromDeg: number, toDeg: number): number {
    return (((toDeg - fromDeg + 180) % 360 + 360) % 360) - 180;
}

/** Interpolação linear escalar (posição). */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Interpolação de ângulo em GRAUS pelo caminho mais curto — os dois passos
 *  fixos distam no máximo turnRate·DT (poucos graus), sem risco de wrap, mas
 *  usa o shortest-path por garantia perto da costura. */
function lerpDeg(fromDeg: number, toDeg: number, t: number): number {
    return fromDeg + shortestDeltaDeg(fromDeg, toDeg) * t;
}

/**
 * Anexada só no PIVOT do PRÓPRIO player. Dona da PREDIÇÃO local (em PASSO FIXO)
 * + do HISTÓRICO por seq + da RECONCILIAÇÃO + do STATE de animação do meu pawn.
 *
 * Passo fixo (Gaffer "Fix Your Timestep"): a simulação avança em blocos de
 * FIXED_DT (= tick do server), acumulando o dt real do render. Cada passo roda
 * a MESMA integração do server (GameLoop.stepMovement) com o MESMO DT — então a
 * predição é float-a-float igual à autoritativa dados os mesmos inputs, e o
 * reconcile não injeta erro por descasar dt variável × passo fixo (era a causa
 * do tremor, e por isso ele dependia de frame rate: 60fps tremia, 120 não).
 *
 * Render interpola prevSim→sim por alpha (=acumulador/FIXED_DT): o sim é 20Hz,
 * mas a tela anda lisa a qualquer fps. Custo: o avatar aparece ATÉ um passo
 * (~50ms) atrás do sim — troca por suavidade (padrão Gaffer). Se pesar como
 * input lag do próprio pawn, é trocar interp por extrapolação aqui (ver update).
 *
 * Separação sim/display: a posição SIMULADA (simX/simZ/simYaw) é a autoritativa
 * — nela roda a predição/colisão e é ela que o reconcile corrige NA HORA. O que
 * vai pro Node (o que aparece) é interp(prev,sim) + offset visual, e o offset
 * decai a zero: a correção some da tela suave, sem teleporte. Em espaço aberto a
 * predição bate com o server, erro ~0, offset ~0: zero tremor.
 *
 * Reconciliação por REWIND/REPLAY: a cada snap do meu pawn, planto a base na
 * verdade do server no tick `ack` (x,z,yaw + velocidade vx,vz) e re-simulo por
 * cima os inputs ainda PENDENTES (seq > ack), deterministicamente, com o mesmo
 * integrate() da predição. Reconstruir do chão firme (em vez de cutucar por um
 * erro no ack) mata a "batida" entre os dois relógios de 20Hz que não estão em
 * fase: em caminhada constante snaps consecutivos dão a MESMA posição atual →
 * correção zero → sem tremor. O compare-no-ack anterior só cutucava e deixava
 * essa batida oscilar o offset. Ver design em GAUNTLET notes.
 */
export default class MineAvatarBehaviour extends Behaviour {
    private readonly network: GauntletNetworkBehaviour;
    //acumulador do passo fixo: soma o dt real e drena em blocos de FIXED_DT.
    private accumSeconds = 0;
    private readonly keysDown = new Set<string>();
    private readonly onKeyDown = (e: KeyboardEvent) => this.keysDown.add(e.code);
    private readonly onKeyUp = (e: KeyboardEvent) => this.keysDown.delete(e.code);

    //Estado SIMULADO (autoritativo) DO PASSO CORRENTE: posição em unidades-
    //mundo, yaw em graus. A predição roda nele; a colisão checa nele; o
    //reconcile corrige ele.
    private simX = 0;
    private simZ = 0;
    private simYawDeg = 0;
    //Estado do passo ANTERIOR — o render interpola prev→sim pra a tela ser
    //lisa entre os passos de 20Hz. Copiado de sim no início de cada passo fixo.
    private prevSimX = 0;
    private prevSimZ = 0;
    private prevSimYawDeg = 0;
    //velocidade PREDITA local, em células/s (mesmo espaço do server).
    private velX = 0;
    private velZ = 0;
    //Offset VISUAL (display = interp(prev,sim) + offset), decai a zero. Recebe o
    //erro no instante da correção pra a tela não pular; some suave nos frames
    //seguintes.
    private offX = 0;
    private offZ = 0;
    private offYawDeg = 0;
    //seq → INTENÇÃO enviada naquele passo (não a posição resultante). A
    //reconciliação por rewind/replay re-simula estes inputs por cima da verdade
    //do server, então precisa da entrada crua, não do resultado. Map preserva
    //ordem de inserção e seq é monotônico → itera em ordem de seq no replay.
    //Podado no ack (o que o server já confirmou não precisa re-simular).
    private readonly pending = new Map<number, { turn: number; move: number }>();
    //AnimatorBehaviour do filho (armature do prefab), achado no start(). O state
    //do MEU pawn é decidido AQUI (predição local), não pelo state do server.
    private animator: AnimatorBehaviour | null = null;
    private lastState = "";

    constructor(network: GauntletNetworkBehaviour) {
        super();
        this.network = network;
    }

    start(): void {
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        //Semente do sim (e do prev, pra o 1º interp não pular) = posição de
        //spawn (o pivot já nasceu na posição do server em onEntsAdded, antes
        //desta behaviour).
        this.simX = this.prevSimX = this.node.position[0];
        this.simZ = this.prevSimZ = this.node.position[2];
        this.simYawDeg = this.prevSimYawDeg = this.node.eulerAngles[1];
        //acha o AnimatorBehaviour do armature-filho (null se o prefab não tiver)
        for (const child of this.node.children) {
            const found = child.behaviours.find((b): b is AnimatorBehaviour => b instanceof AnimatorBehaviour);
            if (found) {
                this.animator = found;
                break;
            }
        }
    }

    dispose(): void {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
    }

    //turn: gira o pawn (A=+1/D=-1). move: anda na direção que o pawn ESTÁ
    //olhando (W=+1/S=-1). Se algum girar/andar pro lado errado, inverte o
    //sinal AQUI e em GameLoop.stepMovement junto.
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
        //---- avança a simulação em PASSOS FIXOS (o coração do fix do tremor):
        //acumula o dt real e drena em blocos de FIXED_DT. Cada bloco roda a
        //MESMA integração do server, com o MESMO DT — predição = autoritativo.
        this.accumSeconds += deltaTime;
        //trava anti-atraso: nunca mais que MAX_STEPS_PER_FRAME de uma vez
        //(descarta o excesso em vez de ressimular/despejar input de golpe).
        const maxAccum = FIXED_DT * MAX_STEPS_PER_FRAME;
        if (this.accumSeconds > maxAccum) this.accumSeconds = maxAccum;
        while (this.accumSeconds >= FIXED_DT) {
            //prev = sim ANTES de dar o passo: é entre esses dois que o render
            //interpola.
            this.prevSimX = this.simX;
            this.prevSimZ = this.simZ;
            this.prevSimYawDeg = this.simYawDeg;
            this.stepFixed();
            this.accumSeconds -= FIXED_DT;
        }

        //---- render: interpola prev→sim por alpha (fração do próximo passo já
        //acumulada). Deixa a tela lisa a 60/120fps mesmo com o sim a 20Hz.
        //(Trocar por extrapolação — sim + vel·accum — mataria o ~50ms de atraso
        //visual do próprio pawn, ao custo de overshoot na parada/virada. Com o
        //moveToward freando suave, a interp é a escolha estável — Gaffer.)
        const alpha = this.accumSeconds / FIXED_DT;

        //---- decai o offset visual a zero (frame-rate independente)
        const keep = Math.exp(-deltaTime * CORRECTION_SMOOTH_RATE);
        this.offX *= keep;
        this.offZ *= keep;
        this.offYawDeg *= keep;

        //---- escreve o Node = interp(prev,sim,alpha) + offset. Único ponto que
        //mexe no transform do pivot (a câmera segue ele; ver CameraFollowBehaviour).
        this.node.position[0] = lerp(this.prevSimX, this.simX, alpha) + this.offX;
        this.node.position[2] = lerp(this.prevSimZ, this.simZ, alpha) + this.offZ;
        this.node.eulerAngles = vec3.create(0, lerpDeg(this.prevSimYawDeg, this.simYawDeg, alpha) + this.offYawDeg, 0);
    }

    /** UM passo de simulação de FIXED_DT — espelho exato de GameLoop.stepMovement
     *  (mesma ordem: yaw → forward → moveToward na vel → state → colisão por
     *  eixo). Amostra a intenção crua UMA vez (keysDown fresco), decide a
     *  animação, e envia o input + registra a intenção pra o replay, tudo no
     *  MESMO passo (um input por passo fixo = ~um por tick do server). */
    private stepFixed(): void {
        const [turn, move] = this.currentIntent();

        //avança o sim (yaw/vel/posição+colisão) — o MESMO integrate que o
        //replay usa, então predição ao vivo e re-simulação são idênticas.
        this.integrate(turn, move);

        //---- state de animação DECIDIDO LOCALMENTE (não espera o server): a
        //componente da velocidade ao longo do forward (recalculado do yaw
        //corrente) decide walk/idle, MESMA regra e MESMO epsilon do server
        //(GameLoop.stepMovement) pra bater. Fica AQUI (não no integrate) pra o
        //replay não ficar disparando playState a cada input re-simulado.
        const yawRad = this.simYawDeg / RAD_TO_DEG;
        const forwardSpeed = this.velX * Math.sin(yawRad) + this.velZ * Math.cos(yawRad);
        const eps = this.network.moveStateEpsilon;
        const state = forwardSpeed > eps ? "walk" : forwardSpeed < -eps ? "walkBackward" : "idle";
        if (state !== this.lastState) {
            this.animator?.playState(state);
            this.lastState = state;
        }

        //---- envio a 20Hz + registro da INTENÇÃO no seq deste input, pra o
        //reconcile re-simular os pendentes por cima da verdade do server.
        const seq = this.network.sendInput(turn, move);
        if (seq !== undefined) {
            this.pending.set(seq, { turn, move });
            //poda o teto de segurança (o ack normalmente já esvaziou antes)
            while (this.pending.size > HISTORY_MAX) {
                this.pending.delete(this.pending.keys().next().value!);
            }
        }
    }

    /** O núcleo PURO da simulação: aplica UMA intenção por FIXED_DT ao estado
     *  (yaw, vel, posição com colisão). Sem input/rede/animação — só física,
     *  pra ser reusado IDÊNTICO na predição ao vivo (stepFixed) e no replay da
     *  reconciliação. Espelho de GameLoop.stepMovement (mesma ordem e conta). */
    private integrate(turn: number, move: number): void {
        //---- yaw: A/D giram a ritmo constante, inclusive parado (parado gira
        //idleTurnMultiplier× mais rápido) — decisão pela intenção crua igual ao server.
        if (turn !== 0) {
            const turnRateDegPerSec = move === 0
                ? this.network.angularVelocityDegPerSec * this.network.idleTurnMultiplier
                : this.network.angularVelocityDegPerSec;
            this.simYawDeg += turn * turnRateDegPerSec * FIXED_DT;
        }

        //---- forward a partir do yaw do SIM (dx=sin, dz=cos, convenção do server).
        const yawRad = this.simYawDeg / RAD_TO_DEG;
        const forwardX = Math.sin(yawRad);
        const forwardZ = Math.cos(yawRad);

        //---- aceleração até a velocidade-alvo (frente/trás conforme o sinal de move).
        const moveSpeed = move >= 0 ? this.network.moveSpeedForward : this.network.moveSpeedBackward;
        const targetVelX = forwardX * move * moveSpeed;
        const targetVelZ = forwardZ * move * moveSpeed;
        const maxDelta = this.network.accel * FIXED_DT;
        this.velX = moveToward(this.velX, targetVelX, maxDelta);
        this.velZ = moveToward(this.velZ, targetVelZ, maxDelta);

        //---- integra a posição em CÉLULAS com a MESMA colisão do server
        //(isFreeAtCells) — não prevê passo que o server rejeitaria; para no eixo.
        if (Math.hypot(this.velX, this.velZ) > 1e-6) {
            const curX = this.network.worldToCellX(this.simX);
            const curZ = this.network.worldToCellZ(this.simZ);
            const wantX = curX + this.velX * FIXED_DT;
            const wantZ = curZ + this.velZ * FIXED_DT;

            let finalX = curX;
            if (this.network.isFreeAtCells(wantX, curZ)) finalX = wantX;
            else this.velX = 0;
            let finalZ = curZ;
            if (this.network.isFreeAtCells(finalX, wantZ)) finalZ = wantZ;
            else this.velZ = 0;

            this.simX = this.network.serverToWorldX(finalX);
            this.simZ = this.network.serverToWorldZ(finalZ);
        }
    }

    /** Chamado pelo NetworkedEntityBehaviour no snap do MEU pawn. REWIND/REPLAY:
     *  planta a base na verdade do server no tick `ack` (posição+yaw+velocidade)
     *  e re-simula os inputs pendentes (seq > ack) por cima, deterministicamente.
     *  A diferença entre a predição ANTIGA e a re-simulada é a correção visível —
     *  vai pro offset, que decai suave: a tela não pula. Em caminhada constante
     *  a re-simulação reproduz a mesma trajetória → correção ~0 → sem tremor.
     *  vx,vz vêm em células/s (mesmo espaço do server), essenciais pra a rampa
     *  de aceleração continuar do ponto certo em vez de reacelerar do zero. */
    reconcile(xCells: number, zCells: number, yawRad: number, vx: number, vz: number, ack: number): void {
        //guarda a predição ANTIGA (fim do último passo) pra medir a correção.
        const oldX = this.simX;
        const oldZ = this.simZ;
        const oldYawDeg = this.simYawDeg;

        //---- base = verdade autoritativa do server no tick `ack`.
        this.simX = this.network.serverToWorldX(xCells);
        this.simZ = this.network.serverToWorldZ(zCells);
        this.simYawDeg = yawRad * RAD_TO_DEG; //re-normaliza junto (server manda em (-PI,PI])
        this.velX = vx;
        this.velZ = vz;

        //---- replay: descarta o que o server já confirmou (seq <= ack) e
        //re-simula os pendentes em ordem de seq, com o MESMO integrate da
        //predição ao vivo. Deletar durante a iteração do Map é seguro em JS.
        for (const [seq, input] of this.pending) {
            if (seq <= ack) {
                this.pending.delete(seq); //já confirmado, não re-simula
                continue;
            }
            this.integrate(input.turn, input.move);
        }

        //---- correção visível = predição re-simulada − antiga. Some pouco (só a
        //misprediction real: parede, batida dos relógios). Absorve no offset e
        //desloca prevSim junto (o render interpola prev→sim; sem mexer no prev o
        //lerp do próximo frame daria um pulinho). Assim a tela não pula.
        const dX = this.simX - oldX;
        const dZ = this.simZ - oldZ;
        const dYawDeg = shortestDeltaDeg(oldYawDeg, this.simYawDeg);
        this.prevSimX += dX;
        this.prevSimZ += dZ;
        this.prevSimYawDeg += dYawDeg;
        this.offX -= dX;
        this.offZ -= dZ;
        this.offYawDeg -= dYawDeg;
    }
}
