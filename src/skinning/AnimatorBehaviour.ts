//AnimatorBehaviour: o estado de PLAYBACK de uma instância (o análogo do
//Animator da Unity). Um clip é asset compartilhado; ISTO é o que varia por
//instância — qual clip, em que tempo, velocidade, e (novo) uma transição em
//andamento entre dois clips. É o que faz "cada cavaleiro numa animação/fase
//diferente" (Medieval Total War): cada instância tem a sua AnimatorBehaviour
//(clonada pelo prefab) e o seu bloco de poses no pass.
//
//Como roda: fica no ROOT da instância (o nó Armature). O World.update visita
//o Armature, roda esta behaviour (que escreve o TRS LOCAL de cada osso a
//partir do(s) clip(s)) e SÓ DEPOIS desce pros ossos — então cada osso já
//fecha a worldMatrix com a pose deste frame. O SkinnedRenderPass então lê
//essas worldMatrix e monta as matrizes de skinning. Nada de escrever pose
//direto.
import { quat, vec3, type Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { Node } from "../node";
import { AnimationClip, applyChannel, sampleQuat, sampleVec3, type AnimationChannel } from "../animation";

type TransitionMode = "immediate" | "crossfade" | "afterCurrentEnds";

export interface ClipTransition {
    mode: TransitionMode;
    /** Só usado em "crossfade": duração da mistura, em segundos. */
    blendSeconds?: number;
}

export interface SetClipOptions {
    loop?: boolean;
    speed?: number;
    transition?: ClipTransition;
}

interface AnimEvent {
    time: number;
    callback: () => void;
}

//Canais do clip agrupados por Node+propriedade — troca a lista plana antiga
//(um item por canal) por um formato que o blend consegue casar osso a osso:
//pra misturar a rotação de DOIS clips no mesmo osso, preciso achar os dois
//canais de rotation daquele Node, um em cada bindings map.
interface NodeChannels {
    translation?: AnimationChannel;
    rotation?: AnimationChannel;
    scale?: AnimationChannel;
}

const IMMEDIATE: ClipTransition = { mode: "immediate" };

//Scratches de módulo pra não alocar por osso/frame durante o blend (só usados
//dentro de applyBlended, que é síncrono — sem risco de reentrância).
const scratchQuatA = quat.identity();
const scratchQuatB = quat.identity();
const scratchVecA = vec3.create();
const scratchVecB = vec3.create();

export class AnimatorBehaviour extends Behaviour {
    /** Clip inicial, tocado a partir do start(). Setado antes de virar
     *  prefab; o clone o copia por referência (asset compartilhado). Depois
     *  do start(), mudar isto direto NÃO tem efeito — use setClip(). */
    clip: AnimationClip | null = null;
    loop = true;
    speed = 1;

    private currentClip: AnimationClip | null = null;
    private currentBindings: Map<Node, NodeChannels> = new Map();
    private currentTime = 0;
    private currentSpeed = 1;
    private currentLoop = true;

    //estado do clip SAINDO durante um crossfade — continua tocando (não
    //congela) até blendT chegar em 1. outgoingClip null = sem blend em curso.
    private outgoingClip: AnimationClip | null = null;
    private outgoingBindings: Map<Node, NodeChannels> = new Map();
    private outgoingTime = 0;
    private outgoingSpeed = 1;
    private outgoingLoop = true;
    private blendT = 1;
    private blendDuration = 0;

    //troca enfileirada por setClip(..., {transition:{mode:"afterCurrentEnds"}}) —
    //só dispara quando o currentClip (que tem que ser loop:false) chega no fim.
    private pending: { clip: AnimationClip; loop: boolean; speed: number } | null = null;

    //Eventos por clip (asset), não por instância — registre no template ANTES
    //do Prefab.fromTemplate pra valer em toda instância, mesma convenção do
    //`clip` inicial. O disparo só é checado enquanto aquele clip for o
    //currentClip desta instância.
    private events = new Map<AnimationClip, AnimEvent[]>();

    override start(): void {
        //Cópia própria da instância: entradas registradas no TEMPLATE (antes
        //do Prefab.fromTemplate) continuam valendo pra esta cópia, mas um
        //addEvent() chamado DEPOIS, nesta instância, não vaza pras outras
        //cópias nem pro template — sem isto, `events` seguiria sendo o MESMO
        //Map (e os MESMOS arrays) compartilhado entre todo mundo, já que o
        //clone default de Behaviour copia campos não-Node por referência.
        this.events = new Map([...this.events].map(([clip, list]) => [clip, [...list]]));
        if (this.clip) {
            this.setClip(this.clip, { loop: this.loop, speed: this.speed, transition: IMMEDIATE });
        }
    }

    /** Registra `callback` pra disparar quando a reprodução de `clip` cruzar
     *  `time` (segundos, dentro da duração do clip). */
    addEvent(clip: AnimationClip, time: number, callback: () => void): void {
        const list = this.events.get(clip);
        if (list) {
            list.push({ time, callback });
        } else {
            this.events.set(clip, [{ time, callback }]);
        }
    }

    removeEvent(clip: AnimationClip, callback: () => void): void {
        const list = this.events.get(clip);
        if (!list) return;
        const idx = list.findIndex((e) => e.callback === callback);
        if (idx >= 0) list.splice(idx, 1);
    }

    /**
     * Troca o clip em reprodução. `transition.mode`:
     * - "immediate" (default): corta na hora, sem mistura.
     * - "crossfade": mistura pose por `blendSeconds` — o clip de SAÍDA
     *   continua tocando (não congela) até a mistura acabar.
     * - "afterCurrentEnds": enfileira a troca pro fim do clip ATUAL. Só faz
     *   sentido saindo de um clip one-shot (loop:false) — um clip em loop
     *   nunca "termina" sozinho, então a troca nunca dispararia.
     */
    setClip(clip: AnimationClip, opts?: SetClipOptions): void {
        const loop = opts?.loop ?? true;
        const speed = opts?.speed ?? 1;
        const mode = opts?.transition?.mode ?? "immediate";

        if (mode === "afterCurrentEnds") {
            this.pending = { clip, loop, speed };
            return;
        }

        const bindings = this.resolveBindings(clip);
        if (mode === "crossfade" && this.currentClip) {
            this.outgoingClip = this.currentClip;
            this.outgoingBindings = this.currentBindings;
            this.outgoingTime = this.currentTime;
            this.outgoingSpeed = this.currentSpeed;
            this.outgoingLoop = this.currentLoop;
            this.blendDuration = Math.max(opts?.transition?.blendSeconds ?? 0, 1e-6);
            this.blendT = 0;
        } else {
            //immediate: descarta qualquer blend em curso, corta na hora.
            this.outgoingClip = null;
            this.blendT = 1;
        }
        this.currentClip = clip;
        this.currentBindings = bindings;
        this.currentTime = 0;
        this.currentSpeed = speed;
        this.currentLoop = loop;
        this.pending = null; //uma troca explícita cancela qualquer troca enfileirada
    }

    //Mapa nome→Node da subárvore desta instância (ossos são Nodes nomeados
    //mixamorig:*) e casamento dos canais do clip contra ela — casar por nome
    //é o que dispensa retargeting: o clip veio de outro arquivo, mas o
    //esqueleto é o mesmo. Agrupa por Node (não por canal) pra o blend achar
    //os dois lados de um mesmo osso.
    private resolveBindings(clip: AnimationClip): Map<Node, NodeChannels> {
        const byName = new Map<string, Node>();
        const walk = (n: Node) => {
            byName.set(String(n.name), n);
            for (const child of n.children) {
                walk(child);
            }
        };
        walk(this.node);

        const bindings = new Map<Node, NodeChannels>();
        let missing = 0;
        for (const channel of clip.channels) {
            const target = byName.get(channel.boneName);
            if (!target) {
                missing++;
                continue;
            }
            let entry = bindings.get(target);
            if (!entry) {
                entry = {};
                bindings.set(target, entry);
            }
            entry[channel.path] = channel;
        }
        if (missing > 0) {
            console.warn(
                `AnimatorBehaviour: ${missing} canais do clip "${clip.name}" sem osso correspondente em "${this.node.name}".`,
            );
        }
        return bindings;
    }

    private advanceTime(time: number, deltaSeconds: number, speed: number, duration: number, loop: boolean): number {
        let t = time + deltaSeconds * speed;
        if (loop && duration > 0) {
            //módulo com correção pra speed negativo (fica em [0, duration))
            t = ((t % duration) + duration) % duration;
        } else {
            t = Math.max(0, Math.min(t, duration));
        }
        return t;
    }

    update(deltaTime: number): void {
        if (!this.currentClip) return;

        const prevTime = this.currentTime;
        this.currentTime = this.advanceTime(
            prevTime, deltaTime, this.currentSpeed, this.currentClip.duration, this.currentLoop,
        );
        this.fireEvents(this.currentClip, prevTime, this.currentTime, this.currentLoop);

        if (this.outgoingClip && this.blendT < 1) {
            this.outgoingTime = this.advanceTime(
                this.outgoingTime, deltaTime, this.outgoingSpeed, this.outgoingClip.duration, this.outgoingLoop,
            );
            this.blendT = Math.min(1, this.blendT + deltaTime / this.blendDuration);
            this.applyBlended();
            if (this.blendT >= 1) {
                this.outgoingClip = null;
                this.outgoingBindings = new Map();
            }
        } else {
            this.applyDirect(this.currentBindings, this.currentTime);
        }

        //Só dispara quando o currentClip realmente chegou no fim: advanceTime
        //já clampou currentTime em duration pra loop:false, então a
        //comparação >= é exata (nunca "quase chega").
        if (this.pending && !this.currentLoop && this.currentTime >= this.currentClip.duration) {
            const { clip, loop, speed } = this.pending;
            this.setClip(clip, { loop, speed, transition: IMMEDIATE });
        }
    }

    private applyDirect(bindings: Map<Node, NodeChannels>, time: number): void {
        for (const [node, ch] of bindings) {
            if (ch.translation) applyChannel(ch.translation, time, node);
            if (ch.rotation) applyChannel(ch.rotation, time, node);
            if (ch.scale) applyChannel(ch.scale, time, node);
        }
    }

    //Mistura a pose do clip ENTRANDO (currentBindings @ currentTime, peso
    //blendT) com a do clip SAINDO (outgoingBindings @ outgoingTime, peso
    //1-blendT). Osso que só existe num dos dois lados (raro, mesmo esqueleto
    //Mixamo nos dois clips) aplica direto, sem mistura — simplificação
    //consciente do escopo "rudimentar".
    private applyBlended(): void {
        const nodes = new Set<Node>([...this.currentBindings.keys(), ...this.outgoingBindings.keys()]);
        for (const node of nodes) {
            const cur = this.currentBindings.get(node);
            const out = this.outgoingBindings.get(node);
            this.blendPath(node, cur?.translation, out?.translation, false);
            this.blendPath(node, cur?.rotation, out?.rotation, true);
            this.blendPath(node, cur?.scale, out?.scale, false);
        }
    }

    private blendPath(
        node: Node,
        curChannel: AnimationChannel | undefined,
        outChannel: AnimationChannel | undefined,
        isRotation: boolean,
    ): void {
        if (curChannel && outChannel) {
            if (isRotation) {
                const a = sampleQuat(outChannel, this.outgoingTime, scratchQuatA);
                const b = sampleQuat(curChannel, this.currentTime, scratchQuatB);
                node.rotation = quat.slerp(a, b, this.blendT, scratchQuatA);
            } else {
                const dst: Vec3 = curChannel.path === "translation" ? node.position : node.scale;
                const a = sampleVec3(outChannel, this.outgoingTime, scratchVecA);
                const b = sampleVec3(curChannel, this.currentTime, scratchVecB);
                vec3.lerp(a, b, this.blendT, dst);
            }
        } else if (curChannel) {
            applyChannel(curChannel, this.currentTime, node);
        } else if (outChannel) {
            applyChannel(outChannel, this.outgoingTime, node);
        }
    }

    //Cruzamento de `time` no intervalo (prevTime, newTime] dispara o evento.
    //Limite inferior exclusivo/superior inclusivo evita disparo duplo quando
    //o tempo pousa exatamente numa fronteira em frames consecutivos. Com
    //loop, um wrap (newTime < prevTime) vira dois segmentos: a cauda
    //(prevTime, duration] e a cabeça [0, newTime].
    private fireEvents(clip: AnimationClip, prevTime: number, newTime: number, loop: boolean): void {
        const list = this.events.get(clip);
        if (!list || list.length === 0) return;
        if (loop && newTime < prevTime) {
            for (const e of list) {
                if (e.time > prevTime || e.time <= newTime) e.callback();
            }
        } else {
            for (const e of list) {
                if (e.time > prevTime && e.time <= newTime) e.callback();
            }
        }
    }
}
