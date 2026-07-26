//Skin: o esqueleto de uma mesh skinnada. É um COMPONENTE de Node (no molde
//de renderable/camera/light) — mora no nó que desenha a mesh e diz quais
//ossos a deformam.
//
//O vértice guarda, por influência, um ID de junta (ver SkinnedMesh) que é o
//ÍNDICE nesta lista `bones` — não um índice de nó do glTF. Então `id` mapeia
//direto pra `bones[id]` e, no shader, pra a matriz `id` DENTRO do bloco desta
//instância (o pass dá a base do bloco; ver skinnedRenderPass). É isto que faz
//`id == slot`, sem tabela de remapeamento.
//
//Divisão de posse, igual ao resto dos assets:
//  - `bones` são Nodes VIVOS da cena (têm transform e worldMatrix que o
//    World.update alimenta). São por-INSTÂNCIA: cada cópia de prefab tem o
//    seu esqueleto, então o clone remapeia estas referências (ver prefab.ts).
//  - `inverseBindMatrices` é dado CONSTANTE do asset (vem do arquivo e nunca
//    muda). É COMPARTILHADO entre instâncias — o clone reusa a mesma
//    referência, não copia os bytes.
import { Node } from "./node";

/**
 * Trava de sanidade, NÃO um orçamento de layout. Os passes reservam
 * exatamente `jointCount` matrizes por instância (bloco de tamanho variável
 * num pool plano — ver skinnedRenderPass), então um esqueleto grande custa
 * memória mas não estoura nada. Este teto só existe pra pegar cedo um
 * esqueleto absurdo (asset errado, loop de clonagem) em vez de deixar o pool
 * inchar em silêncio. xbot usa 65.
 */
export const MAX_BONES = 256;

export class Skin {
  /**
   * Ossos em ordem de índice de junta: `bones[id]` é o osso que o ID `id`
   * (vindo do vértice) referencia. Nodes vivos da cena — o pass lê a
   * `worldMatrix` de cada um por frame.
   */
  readonly bones: Node[];

  /**
   * Inverse bind matrices, uma por osso, em blocos contíguos de 16 floats
   * (column-major, como o glTF/WebGPU). `inverseBindMatrices[id*16 .. id*16+15]`
   * é a matriz da junta `id`. Mapeia o espaço da mesh (bind pose) pro espaço
   * local do osso — é o que, combinado com a pose atual do osso, dá a matriz
   * de skinning. Constante do asset; compartilhada entre instâncias.
   */
  readonly inverseBindMatrices: Float32Array;

  constructor(bones: Node[], inverseBindMatrices: Float32Array) {
    if (bones.length > MAX_BONES) {
      //Nada no shader quebra com mais que isto (o bloco é do tamanho do
      //esqueleto), mas um esqueleto deste tamanho é quase certamente bug de
      //asset/clonagem. Falha cedo em vez de inchar o pool em silêncio.
      throw new Error(
        `Skin com ${bones.length} ossos excede a trava de sanidade de ${MAX_BONES} (se for legítimo, aumente MAX_BONES em skin.ts).`,
      );
    }
    this.bones = bones;
    this.inverseBindMatrices = inverseBindMatrices;
  }

  /** Quantos ossos este esqueleto tem (== bones.length). */
  get jointCount(): number {
    return this.bones.length;
  }

  /**
   * A inverse bind da junta `j` como uma VIEW (não cópia) sobre o buffer
   * compartilhado — pronta pra entrar num mat4.multiply. Não guarde a
   * referência esperando um snapshot; é só pra consumo imediato no pass.
   */
  inverseBind(j: number): Float32Array {
    return this.inverseBindMatrices.subarray(j * 16, j * 16 + 16);
  }

  /**
   * Cópia desta skin com os ossos REMAPEADOS pelo `map` original→clone da
   * clonagem de prefab. As inverseBindMatrices (constantes) são
   * compartilhadas, não duplicadas. Um osso ausente no map é um bug de
   * clonagem (a subárvore deveria conter o esqueleto inteiro) — avisa e
   * mantém o original pra não quebrar em silêncio.
   */
  clone(map: Map<Node, Node>): Skin {
    const bones = this.bones.map((bone) => {
      const cloned = map.get(bone);
      if (!cloned) {
        console.warn(
          `Skin.clone: osso "${bone.name}" fora da subárvore clonada — a referência aponta pro template.`,
        );
        return bone;
      }
      return cloned;
    });
    return new Skin(bones, this.inverseBindMatrices);
  }
}
