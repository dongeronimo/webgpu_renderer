//Liga um Node ao que ele desenha. O Renderable não conhece objetos da
//WebGPU — ele só guarda a referência da Mesh (que é quem tem os buffers)
//e o tipo dela, para o render pass escolher o pipeline certo sem precisar
//de instanceof.
import { MeshType } from "./mesh";
import type { Mesh } from "./mesh";
import type { Material } from "./material";

export class Renderable {
  readonly mesh: Mesh;
  readonly meshType: MeshType;
  /** Preenchido depois do load (ex.: no createWorld) — o glTF não traz nossos materiais. */
  public material:Material|undefined=undefined;
  constructor(mesh: Mesh) {
    this.mesh = mesh;
    this.meshType = mesh.type;
  }
}
