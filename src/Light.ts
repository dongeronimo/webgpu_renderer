//Light: componente de luz, no molde de Renderable/Camera/Skin — mora num
//campo opcional do Node (node.light) e não conhece objetos de GPU; quem lê
//os campos e monta os buffers é a coleta de luzes do mundo que a usa (hoje:
//GauntletLighting, ver src/gauntlet/gauntletLighting.ts — os outros mundos
//ainda ignoram os campos e só checam node.light != null).
//
//Direção (Spot/Directional): NÃO mora aqui. É derivada na coleta a partir
//do -Z da worldMatrix do nó dono, a mesma convenção do Camera ("a câmera
//olha pelo -Z do nó" — ver camera.ts). Guardar uma direção própria aqui
//duplicaria a rotação do nó e podia dessincronizar.

/**
 * Discriminante de subclasse de Light, no mesmo molde do MeshType (mesh.ts):
 * cada subclasse tem seu `readonly type`, e quem coleta luzes faz o downcast
 * por ele em vez de instanceof.
 */
export enum LightType {
  Point,
  Spot,
  Directional,
}

export abstract class Light {
  abstract readonly type: LightType;

  /** Cor da luz, RGB linear em [0,1]. Multiplica `intensity` na composição. */
  color: [number, number, number] = [1, 1, 1];

  /**
   * "Potência" da luz. Point/Spot: numerador da atenuação linear
   * intensity/distância (mesma convenção que já existia, hardcoded como
   * light0Power nos materiais do Gauntlet). Directional: multiplicador
   * direto, sem atenuação (fonte infinitamente distante).
   */
  intensity: number = 1;

  /**
   * Se esta luz pode ser descartada pelo culling. Ainda sem efeito nenhum —
   * é só o campo, a lógica de culling vem depois (luzes tipo "sol" vão
   * querer cullable=false pra nunca sumir).
   */
  cullable: boolean = true;
}

export class PointLight extends Light {
  override readonly type = LightType.Point;
}

export class SpotLight extends Light {
  override readonly type = LightType.Spot;

  /** Ângulo (radianos) a partir do eixo central onde o cone começa a atenuar (100% de luz até aqui). */
  innerConeAngle: number = Math.PI / 8;
  /** Ângulo (radianos) onde a luz cai a zero. */
  outerConeAngle: number = Math.PI / 6;
}

export class DirectionalLight extends Light {
  override readonly type = LightType.Directional;
}
