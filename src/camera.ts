//Componente de câmera, nos moldes do Renderable: mora num campo opcional
//do Node (node.camera) e guarda só as propriedades de projeção.
//
//A view não está aqui de propósito — ela vem do nó dono: é a inversa da
//matriz de mundo dele (a câmera olha pelo -Z do nó, a mesma convenção do
//lookAt e do glTF).
import { mat4, type Mat4 } from "wgpu-matrix";

const DEG_TO_RAD = Math.PI / 180;

export class Camera {
  /** Abertura vertical do campo de visão, em graus. */
  fovY = 60;
  /** Largura / altura do viewport. Atualize quando o canvas mudar de tamanho. */
  aspect = 1;
  /** Distância do plano de corte próximo. Tem que ser > 0. */
  near = 0.1;
  /** Distância do plano de corte distante. */
  far = 1000;

  /**
   * Matriz de perspectiva. A mat4.perspective da wgpu-matrix já gera o z
   * de clip em [0, 1] como o WebGPU espera (em OpenGL seria [-1, 1] —
   * cuidado ao portar fórmulas de lá).
   */
  getProjectionMatrix(dst?: Mat4): Mat4 {
    return mat4.perspective(this.fovY * DEG_TO_RAD, this.aspect, this.near, this.far, dst);
  }
}
