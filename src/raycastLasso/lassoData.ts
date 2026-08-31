//Um LASSO capturado: o contorno que o usuário desenhou MAIS a câmera do
//instante em que ele desenhou. Os dois juntos, e nunca separados — um
//contorno sem a câmera dele não descreve região nenhuma no volume, e é por
//isso que isto é uma estrutura só.
//
//POR QUE UMA MATRIZ, E NÃO UMA DIREÇÃO: com câmera perspectiva o sólido que
//o traço recorta não é um prisma, é uma PIRÂMIDE infinita com ápice no olho.
//Guardar a matriz reproduz exatamente isso (e é o que faz sumir o que estava
//sob o traço, inclusive nos cantos da tela); guardar um vetor de direção
//daria um prisma, que só coincide com o desenho no centro da imagem.
//
//A matriz vai DIRETO de pLocal pro clip do lasso (clipFromLocal = proj · view ·
//model), e não só a viewProj, de propósito: assim o corte é solidário ao
//VOLUME. Se o nó do volume girar, a região removida gira junto — é uma marca
//feita na peça, não um buraco parado no espaço. E de quebra o shader recebe
//uma matriz só, já composta na CPU.
import type { Mat4 } from "wgpu-matrix";

/** Contorno + câmera congelada. Imutável depois de criado. */
export interface LassoData {
    /** Identidade estável (chave de lista, alvo do remover/undo). */
    id: number;
    /**
     * O contorno em NDC, x e y intercalados: [x0,y0, x1,y1, ...]. NDC (e não
     * pixels) porque é a coordenada que o shader vai usar, e porque imuniza o
     * traço contra o framebufferScale e contra resize da janela.
     *
     * Aberto: o fechamento (último→primeiro) é implícito, como em todo lasso —
     * ninguém guarda o primeiro ponto duas vezes.
     */
    points: Float32Array;
    /**
     * mat4 column-major (16 floats): leva o ponto do espaço LOCAL do volume
     * (o cubo [-0.5,0.5]³ que o raymarch percorre) pro clip da câmera
     * congelada. O teste dentro/fora é `(M·p).xy / (M·p).w` contra `points`.
     */
    clipFromLocal: Mat4;
    /**
     * false = REMOVER o que está dentro (o normal). true = MANTER só o que
     * está dentro, jogando fora todo o resto — o crop.
     *
     * Os keep se combinam por INTERSEÇÃO: com dois deles, sobra só o que está
     * dentro dos dois. É a semântica certa de recorte, e é o que deixa cortar
     * de dois ângulos pra isolar uma caixa no espaço.
     *
     * Vive aqui e não num "modo" global porque é propriedade DAQUELE traço:
     * decidida com o Alt na hora de desenhar e congelada junto com a câmera.
     */
    keep: boolean;
}

//Contador de módulo: ids não podem vir do índice na lista (remover um do meio
//renumeraria os outros) nem do reducer (que é puro).
let nextId = 1;

export function nextLassoId(): number {
    return nextId++;
}
