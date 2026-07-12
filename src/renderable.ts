//Liga um Node ao que ele desenha. O Renderable não conhece objetos da
//WebGPU — ele só guarda a referência da Mesh (que é quem tem os buffers)
//e o tipo dela, para o render pass escolher o pipeline certo sem precisar
//de instanceof.
import { vec3, type Mat4, type Vec3 } from "wgpu-matrix";
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
  /** Fatias translúcidas compostas por blend de hardware (VR clássico). */
  TransparentSlices = 1 << 2,
  /**
   * Volume raymarched integrado à cena (gameVolume): o nó carrega a mesh do
   * cubo proxy e a model matrix, mas NÃO é desenhado pelo pass de geometria —
   * quem o consome é o SmokeVolumePass, que compõe a fumaça por cima dos opacos.
   */
  Volume = 1 << 5,
  //futuro: Shadow = 1 << 3, Reflection = 1 << 4...
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

  /**
   * AABB de MUNDO deste renderable: transforma os 8 cantos do AABB local da
   * mesh por `worldMatrix` e devolve o min/max envolvente. Lida com rotação e
   * escala (por isso os 8 cantos, não só min/max). Infra compartilhada:
   * frustum culling, GI e a voxelização de obstáculo do fluido.
   *
   * `worldMatrix` é column-major (o mesmo do Node). Passe `node.worldMatrix`
   * (cacheado, válido pós-update) ou `node.getWorldMatrix()` (fresco, fora do
   * frame — ex.: no createWorld).
   */
  worldAABB(worldMatrix: Mat4): { min: Vec3; max: Vec3 } {
    const lo = this.mesh.boundsMin;
    const hi = this.mesh.boundsMax;
    const min = vec3.create(Infinity, Infinity, Infinity);
    const max = vec3.create(-Infinity, -Infinity, -Infinity);
    for (let c = 0; c < 8; c++) {
      const x = (c & 1) ? hi[0] : lo[0];
      const y = (c & 2) ? hi[1] : lo[1];
      const z = (c & 4) ? hi[2] : lo[2];
      const wx = worldMatrix[0] * x + worldMatrix[4] * y + worldMatrix[8] * z + worldMatrix[12];
      const wy = worldMatrix[1] * x + worldMatrix[5] * y + worldMatrix[9] * z + worldMatrix[13];
      const wz = worldMatrix[2] * x + worldMatrix[6] * y + worldMatrix[10] * z + worldMatrix[14];
      if (wx < min[0]) min[0] = wx; if (wy < min[1]) min[1] = wy; if (wz < min[2]) min[2] = wz;
      if (wx > max[0]) max[0] = wx; if (wy > max[1]) max[1] = wy; if (wz > max[2]) max[2] = wz;
    }
    return { min, max };
  }
}
