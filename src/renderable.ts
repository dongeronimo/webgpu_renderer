//Liga um Node ao que ele desenha. O Renderable não conhece objetos da
//WebGPU — ele só guarda a referência da Mesh (que é quem tem os buffers)
//e o tipo dela, para o render pass escolher o pipeline certo sem precisar
//de instanceof.
import { MeshType } from "./mesh";
import type { Mesh } from "./mesh";
import type { Material } from "./material";

/**
 * Bits dos render passes em que um Renderable pode ser desenhado.
 * É bitmask porque um objeto pode participar de VÁRIOS passes (no futuro:
 * main + shadow + reflection...), e enum numérico porque é menos error
 * prone e mais rápido de comparar que string.
 */
export enum RenderPassBit {
  Main = 1 << 0,
  Skybox = 1 << 1,
  //futuro: Shadow = 1 << 2, Reflection = 1 << 3, Volume = 1 << 4...
}

export class Renderable {
  readonly mesh: Mesh;
  readonly meshType: MeshType;
  /** Preenchido depois do load (ex.: no createWorld) — o glTF não traz nossos materiais. */
  public material:Material|undefined=undefined;
  /**
   * Em quais passes este renderable é desenhado (OR de RenderPassBit).
   * Cada pass testa seu bit ao percorrer a árvore e pula quem não tem —
   * é assim que o cubo do skybox vive na árvore do mundo sem aparecer no
   * main pass. Default: só o main pass, o caso de todo objeto comum.
   * (number e não RenderPassBit: o OR de dois bits já não é membro do enum.)
   */
  public passMask: number = RenderPassBit.Main;
  constructor(mesh: Mesh) {
    this.mesh = mesh;
    this.meshType = mesh.type;
  }
}
