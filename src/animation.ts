//Animação por keyframes do glTF. Um AnimationClip é asset CONSTANTE e
//COMPARTILHADO (dono: o World, como as meshes) — não referencia Node nenhum.
//Os canais endereçam o osso pelo NOME (mixamorig:*), não por índice/ref, pra
//que o MESMO clip toque em QUALQUER instância do MESMO esqueleto (Mixamo),
//sem retargeting. Quem casa nome→Node é a AnimatorBehaviour, por instância.
//
//Modelo glTF: cada canal amostra UMA propriedade (translation/rotation/scale)
//de um osso, via um sampler = (times[], values[], interpolação). Os valores
//são vec3 pra T/S e quat pra R.
import { quat, vec3 } from "wgpu-matrix";
import type { Node } from "./node";

/** Propriedade local do osso que um canal anima. */
export type AnimPath = "translation" | "rotation" | "scale";
/** Interpolação entre keyframes. (CUBICSPLINE ainda não suportada — Mixamo
 *  exporta LINEAR/STEP; ver applyChannel.) */
export type AnimInterp = "LINEAR" | "STEP" | "CUBICSPLINE";

export interface AnimationChannel {
  /** Nome do osso alvo (mixamorig:*). Casado na instância pela AnimatorBehaviour. */
  boneName: string;
  path: AnimPath;
  interp: AnimInterp;
  /** Timestamps das keyframes em segundos, crescentes. Tamanho N. */
  times: Float32Array;
  /** Valores intercalados: N×3 (translation/scale) ou N×4 (rotation). */
  values: Float32Array;
}

export class AnimationClip {
  readonly name: string;
  /** Duração em segundos (maior timestamp entre os canais). */
  readonly duration: number;
  readonly channels: AnimationChannel[];

  constructor(name: string, duration: number, channels: AnimationChannel[]) {
    this.name = name;
    this.duration = duration;
    this.channels = channels;
  }
}

//Scratch de módulo pra não alocar por canal/frame. Só é usado dentro de
//applyChannel, que é síncrono — sem risco de reentrância.
const scratchQuat = quat.identity();

/**
 * Amostra `channel` em `time` (segundos) e escreve o resultado na
 * propriedade local correspondente de `node` (posição/rotação/escala).
 * `time` deve já vir dentro de [0, duração] (o loop é da AnimatorBehaviour).
 *
 * T/S entram no lugar em `node.position`/`node.scale` (Vec3 mutáveis); R passa
 * pelo setter de `node.rotation` (que normaliza). Rotação usa SLERP; T/S, LERP.
 */
export function applyChannel(channel: AnimationChannel, time: number, node: Node): void {
  const { times, values, path, interp } = channel;
  const n = times.length;

  //---- acha o segmento [i0, i1] e o fator u ∈ [0,1] ----
  let i0: number;
  let i1: number;
  let u: number;
  if (n === 1 || time <= times[0]) {
    i0 = 0;
    i1 = 0;
    u = 0;
  } else if (time >= times[n - 1]) {
    i0 = n - 1;
    i1 = n - 1;
    u = 0;
  } else {
    //busca binária: maior i com times[i] <= time
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    i0 = lo;
    i1 = lo + 1;
    const span = times[i1] - times[i0];
    u = span > 0 ? (time - times[i0]) / span : 0;
  }
  //STEP: segura a keyframe da esquerda (sem interpolar).
  if (interp === "STEP") {
    i1 = i0;
    u = 0;
  }

  if (path === "rotation") {
    const a = values.subarray(i0 * 4, i0 * 4 + 4);
    const b = values.subarray(i1 * 4, i1 * 4 + 4);
    //slerp(a, b, 0) == a, então o caso u==0 cai naturalmente aqui.
    node.rotation = quat.slerp(a, b, u, scratchQuat);
  } else {
    const a = values.subarray(i0 * 3, i0 * 3 + 3);
    const b = values.subarray(i1 * 3, i1 * 3 + 3);
    //escreve direto no vec3 mutável do nó (sem alocar nem passar por setter).
    vec3.lerp(a, b, u, path === "translation" ? node.position : node.scale);
  }
}
