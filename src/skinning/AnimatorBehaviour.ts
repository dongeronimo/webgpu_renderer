//AnimatorBehaviour: o estado de PLAYBACK de uma instância (o análogo do
//Animator da Unity). Um clip é asset compartilhado; ISTO é o que varia por
//instância — qual clip, em que tempo, velocidade. É o que faz "cada cavaleiro
//numa animação/fase diferente" (Medieval Total War): cada instância tem a sua
//AnimatorBehaviour (clonada pelo prefab) e o seu bloco de poses no pass.
//
//Como roda: fica no ROOT da instância (o nó Armature). O World.update visita
//o Armature, roda esta behaviour (que escreve o TRS LOCAL de cada osso a
//partir do clip) e SÓ DEPOIS desce pros ossos — então cada osso já fecha a
//worldMatrix com a pose deste frame. O SkinnedRenderPass então lê essas
//worldMatrix e monta as matrizes de skinning. Nada de escrever pose direto.
import { Behaviour } from "../behaviour";
import { Node } from "../node";
import { AnimationClip, applyChannel, type AnimationChannel } from "../animation";

export class AnimatorBehaviour extends Behaviour {
    /** Clip a tocar (asset compartilhado). Setado antes de virar prefab; o
     *  clone o copia por referência. Sem clip, a behaviour é no-op. */
    clip: AnimationClip | null = null;
    /** Posição na timeline, em segundos. Por-instância — sorteie após o
     *  instantiate pra dessincronizar uma multidão. */
    time = 0;
    /** Multiplicador de velocidade (1 = tempo real; negativo = ré). */
    speed = 1;
    loop = true;

    //Resolvido no start(), por instância: cada canal já apontando pro Node do
    //osso DESTA cópia. É reatribuído (não mutado) no start, então o clone
    //default — que copia a referência do array vazio do template — fica ok.
    private bindings: { channel: AnimationChannel; node: Node }[] = [];

    override start(): void {
        if (!this.clip) {
            return;
        }
        //Mapa nome→Node da subárvore desta instância (ossos são Nodes nomeados
        //mixamorig:*). Casar por nome é o que dispensa retargeting: o clip veio
        //de outro arquivo, mas o esqueleto é o mesmo.
        const byName = new Map<string, Node>();
        const walk = (n: Node) => {
            byName.set(String(n.name), n);
            for (const child of n.children) {
                walk(child);
            }
        };
        walk(this.node);

        this.bindings = [];
        let missing = 0;
        for (const channel of this.clip.channels) {
            const target = byName.get(channel.boneName);
            if (target) {
                this.bindings.push({ channel, node: target });
            } else {
                missing++;
            }
        }
        if (missing > 0) {
            //Osso do clip que não existe neste esqueleto: esqueleto incompatível
            //(ou o clip é de outro personagem). Avisa uma vez, segue com o resto.
            console.warn(
                `AnimatorBehaviour: ${missing} canais do clip "${this.clip.name}" sem osso correspondente em "${this.node.name}".`,
            );
        }
    }

    update(deltaTime: number): void {
        if (!this.clip || this.bindings.length === 0) {
            return;
        }
        const duration = this.clip.duration;
        this.time += deltaTime * this.speed;
        if (this.loop && duration > 0) {
            //módulo com correção pra speed negativo (fica em [0, duration))
            this.time = ((this.time % duration) + duration) % duration;
        } else {
            this.time = Math.max(0, Math.min(this.time, duration));
        }
        for (const { channel, node } of this.bindings) {
            applyChannel(channel, this.time, node);
        }
    }
}
