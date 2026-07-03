//Liga um Node ao que ele desenha. O Renderable não conhece objetos da
//WebGPU — ele só guarda a referência da Mesh (que é quem tem os buffers)
//e o tipo dela, para o render pass escolher o pipeline certo sem precisar
//de instanceof.
import { Material } from "@gltf-transform/core";
import { MeshType } from "./mesh";
import type { Mesh } from "./mesh";

export class Renderable {
  readonly mesh: Mesh;
  readonly meshType: MeshType;
  public material:Material|undefined=undefined;
  //TODO: Material.
  constructor(mesh: Mesh) {
    this.mesh = mesh;
    this.meshType = mesh.type;
  }
}
