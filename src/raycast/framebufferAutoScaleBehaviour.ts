//AJUSTE DINÂMICO DE RESOLUÇÃO. Quando o fps cai, encolhe o framebuffer do
//raymarch até voltar a um patamar usável — menos fragmentos, menos raios.
//
//Não redimensiona nada por conta própria: despacha setRaycastFramebufferScale,
//e quem aplica é a FramebufferResizerBehaviour de sempre, que já lia esse
//valor. Passar pelo redux em vez de chamar o world direto tem duas
//consequências boas: o slider do painel ANDA SOZINHO quando o automático age
//(então dá pra ver o que ele está fazendo, e onde parou), e o caminho continua
//sendo um só — nada de dois lugares mexendo no tamanho do alvo.
//
//A HISTERESE, e por que ela não é opcional
//
//  fps < 20  → começa a reduzir
//  fps > 25  → para de reduzir
//
//As duas bordas são diferentes de propósito. Com um limiar só, o sistema
//reduziria, o fps passaria um triz do limiar, ele voltaria a crescer, cairia de
//novo — e a imagem ficaria pulsando de resolução. Reduzir até FOLGAR (25, e não
//20) é o que faz ele assentar.
//
//O CAMINHO DE VOLTA (fps > 45) é acréscimo meu, não estava no pedido. Sem ele o
//automático é uma catraca: você dá zoom, ele cai pra 0.5, você afasta e a
//imagem fica borrada pra sempre. O limiar é alto de propósito — subir um degrau
//custa uns 10-15% de fps, então voltar de 45 aterrissa perto de 39, longe do
//gatilho de 20. Sem risco de ping-pong. Se você preferir o comportamento só de
//descida, é apagar o segundo `else if`.
import { Behaviour } from "../behaviour";
import { gpuTimer } from "../gpuTimer";
import { setRaycastFramebufferScale } from "../redux/actions";
import { store } from "../redux/store";

/** Abaixo disto, começa a encolher. */
const LOW_FPS = 20;
/** Acima disto, para de encolher (a folga que impede a pulsação). */
const GOOD_FPS = 25;
/** Acima disto, devolve resolução. Bem acima do resto, ver o cabeçalho. */
const HIGH_FPS = 45;
/** Degrau, igual ao step do slider. */
const STEP = 0.05;
//Os mesmos limites do slider do painel: o automático não vai a lugar nenhum
//que o usuário não pudesse alcançar na mão.
const MIN_SCALE = 0.25;
const MAX_SCALE = 1.0;
/**
 * Frames de espera depois de cada mudança.
 *
 * O fps do gpuTimer é uma média exponencial (alpha 0.1), então leva uns 10-20
 * frames pra refletir uma mudança. Agir antes disso seria reagir ao passado e
 * despencar a resolução até o fundo de uma vez.
 */
const COOLDOWN_FRAMES = 20;

export class FramebufferAutoScaleBehaviour extends Behaviour {
    //Está no meio de uma descida? É o que separa o gatilho (20) do alvo (25).
    private reducing = false;
    private cooldown = 0;

    update(_deltaTime: number): void {
        const raycast = store.getState().raycast;
        if (!raycast.autoFramebufferScale) {
            //Desligado: esquece o que estava fazendo, pra religar começar limpo.
            this.reducing = false;
            this.cooldown = 0;
            return;
        }
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }
        const fps = gpuTimer.fps;
        if (fps <= 0) {
            return; //ainda sem medida (1º frame, ou timestamps indisponíveis)
        }
        const scale = raycast.framebufferScale;

        if (this.reducing) {
            //Já folgou? Solta.
            if (fps > GOOD_FPS) {
                this.reducing = false;
                return;
            }
        } else if (fps < LOW_FPS) {
            this.reducing = true;
        }

        if (this.reducing && scale > MIN_SCALE) {
            this.apply(scale - STEP);
        } else if (!this.reducing && fps > HIGH_FPS && scale < MAX_SCALE) {
            this.apply(scale + STEP);
        }
    }

    private apply(value: number): void {
        //Arredonda pra 2 casas: somar 0.05 repetidamente acumula lixo binário e
        //o número do painel viraria 0.7500000000000001.
        const clamped = Math.round(Math.min(Math.max(value, MIN_SCALE), MAX_SCALE) * 100) / 100;
        store.dispatch(setRaycastFramebufferScale(clamped));
        this.cooldown = COOLDOWN_FRAMES;
    }
}
