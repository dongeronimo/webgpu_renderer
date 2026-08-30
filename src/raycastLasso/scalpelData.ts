//Um BISTURI capturado. Parente do LassoData mas tipo PRÓPRIO de propósito: o
//que as duas ferramentas produzem é diferente o bastante pra não caber num
//campo "modo".
//
//LASSO   — contorno + câmera. Remove a PIRÂMIDE INFINITA: tudo que estava sob
//          o traço some, da pele ao outro lado do paciente. É um furo.
//BISTURI — contorno + câmera + um MAPA DA CAMADA (onde o material começa E
//          onde acaba, por pixel) + uma margem. Remove a primeira camada
//          inteira, com a espessura que ELA tem em cada ponto. É um descasque
//          que conhece a estrutura.
//
//A diferença estrutural é o mapa da camada: ele não cabe aqui (mora na GPU,
//numa camada de um texture_2d_array rg32float, escrita pelo ScalpelDepthPass)
//e é o que obriga a captura a rodar um render extra no pointerup. É a mesma
//relação de um projective texturing pra um shadow map: o lasso reprojeta e
//consulta; o bisturi reprojeta, consulta E compara profundidade.
import type { Mat4 } from "wgpu-matrix";
import type { CtfPoint } from "../ctf";

/** Contorno + câmera congelada + espessura do descasque. Imutável. */
export interface ScalpelData {
    /** Identidade estável. Numeração PRÓPRIA, independente da dos lassos. */
    id: number;
    /**
     * O contorno em NDC, x e y intercalados, ABERTO (o fechamento
     * último→primeiro é implícito). Mesmo formato do lasso — a rasterização
     * (contourMask.ts) é compartilhada, é só geometria 2D.
     */
    points: Float32Array;
    /**
     * mat4 column-major: pLocal ([-0.5,0.5]³) → clip da câmera congelada.
     * Aqui ela tem um papel A MAIS que no lasso: o `w` do ponto projetado é a
     * profundidade LINEAR naquela câmera, e é ele que se compara com o mapa.
     */
    clipFromLocal: Mat4;
    /**
     * Quanto remover A MAIS, além do fim da camada detectada, em unidades de
     * MUNDO (o volume é normalizado com o maior eixo = 1).
     *
     * É MARGEM, não espessura: quem manda na espessura é a estrutura, que o
     * mapa mede pixel a pixel. Isto aqui é o ajuste fino pra quando a camada
     * termina um tiquinho antes do que o olho considera o fim dela. 0 é um
     * valor perfeitamente normal.
     *
     * Guardada POR BISTURI e não global: cada corte fica com a margem que
     * tinha quando foi feito, como o tamanho do pincel.
     */
    margin: number;
    /**
     * A CTF do instante do traço, CONGELADA junto com a câmera.
     *
     * Não é redundância com o state.ctf: o critério de superfície (alpha da CTF
     * acima do mínimo) depende dela, então o mapa da camada só é reproduzível
     * com a mesma transferência que estava valendo quando o corte foi feito.
     * Sem isto, desfazer e refazer um bisturi com a CTF diferente devolveria um
     * corte DIFERENTE do original — o undo deixaria de ser fiel.
     *
     * Guardar a referência é seguro: o ctfReducer cria array novo a cada
     * mudança, nunca mexe no que já existe.
     *
     * A consequência boa vem de graça: mexer na CTF depois não remexe mais em
     * corte nenhum, e a edição de CTF deixou de disparar recaptura.
     */
    ctf: readonly CtfPoint[];
}

//Contador próprio: os ids não se misturam com os dos lassos porque as duas
//listas são independentes (um id 3 de lasso e um id 3 de bisturi coexistem).
let nextId = 1;

export function nextScalpelId(): number {
    return nextId++;
}
