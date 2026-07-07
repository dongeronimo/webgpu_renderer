import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from "wgpu-matrix";
import type { Renderable } from "./renderable";
import type { Camera } from "./camera";
import type { Behaviour } from "./behaviour";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// Convenção de Euler: graus, aplicados na ordem Z, depois X, depois Y em
// eixos do mundo (R = Ry * Rx * Rz) — a mesma convenção da Unity.
// Na nomenclatura do quat.fromEuler da wgpu-matrix, essa ordem se chama "yxz".
const EULER_ORDER = "yxz";

/**
 * Nó de cena com transformação (posição, rotação, escala) e hierarquia.
 *
 * ## Rotação: quaternion por dentro, Euler por fora
 *
 * A fonte da verdade é sempre o quaternion (`_rotation`) — é ele que entra
 * nas matrizes e que deve ser usado para interpolação/composição. Os ângulos
 * de Euler existem como uma *visão editável* dessa rotação, com a mesma
 * semântica da Unity/Unreal:
 *
 * - Ao **setar** `eulerAngles`, os valores são guardados em `_euler`
 *   exatamente como foram passados, sem clamp: setar `(500, -720.5, 1234)`
 *   lê de volta `(500, -720.5, 1234)`. Isso permite animar/editar ângulos
 *   continuamente sem saltos ao cruzar 360°.
 * - Ao **setar** `rotation` (quaternion) diretamente, esses valores "crus"
 *   deixam de ser válidos — um quaternion não lembra quantas voltas foram
 *   dadas. A flag `_eulerInSync` marca o cache como obsoleto e a próxima
 *   leitura de `eulerAngles` deriva ângulos canônicos do quaternion
 *   (x em [-90, 90], y/z em [-180, 180]).
 *
 * Os getters de `rotation` e `eulerAngles` retornam **cópias**: mutar o
 * array retornado não afeta o nó (e não passaria pelo setter, que é quem
 * mantém quaternion e Euler consistentes). Já `position` e `scale` são
 * arrays públicos mutáveis (estilo three.js) — não há estado derivado
 * deles, então podem ser editados no lugar: `vec3.set(1, 2, 3, n.position)`.
 *
 * ## Hierarquia
 *
 * Um nó tem no máximo um pai (`parent`, ou `null` para nós de raiz) e
 * n filhos. `setParent` é a única operação que altera a estrutura — remove
 * o nó da lista do pai antigo, valida ciclos e insere no novo pai;
 * `addChild`/`removeChild` são atalhos sobre ele. As duas pontas da relação
 * (`_parent` de um lado, `_children` do outro) nunca ficam dessincronizadas.
 */
export class Node {
  public name:String = "foobar";

  /** O que este nó desenha, se desenhar algo. `null` = nó puramente de transform. */
  public renderable: Renderable | null = null;

  /**
   * Projeção de câmera, se este nó for uma câmera. A view é deste nó:
   * inversa da sua matriz de mundo (a câmera olha pelo -Z dele).
   */
  public camera: Camera | null = null;

  /** Custom properties do Blender (extras do glTF), como vieram do arquivo. */
  public extras: Record<string, unknown> = {};

  /**
   * Behaviours anexadas a este nó. O loader instancia a partir da custom
   * property "behaviours" (lista separada por ';'); o World.update as invoca.
   */
  public readonly behaviours: Behaviour[] = [];
  /** Posição local (relativa ao pai). Mutável no lugar. */
  readonly position: Vec3 = vec3.create(0, 0, 0);

  /** Escala local, por eixo. Mutável no lugar. */
  readonly scale: Vec3 = vec3.create(1, 1, 1);

  /** Rotação local — fonte da verdade, sempre um quaternion unitário. */
  private readonly _rotation: Quat = quat.identity();

  /**
   * Últimos ângulos de Euler setados pelo usuário, em graus, sem clamp
   * (pode conter 500°, -720°...). Só é confiável enquanto `_eulerInSync`
   * for true; setar o quaternion diretamente o invalida.
   */
  private readonly _euler: Vec3 = vec3.create(0, 0, 0);
  private _eulerInSync = true;

  private _parent: Node | null = null;
  private readonly _children: Node[] = [];

  // --- rotação ---

  /** Rotação como quaternion unitário (retorna uma cópia). */
  get rotation(): Quat {
    return quat.clone(this._rotation);
  }

  set rotation(q: Quat) {
    // Normaliza na entrada para que a extração de Euler e as matrizes
    // possam assumir quaternion unitário.
    quat.normalize(q, this._rotation);
    this._eulerInSync = false;
  }

  /**
   * Rotação como ângulos de Euler em graus (retorna uma cópia).
   *
   * Ler depois de setar devolve exatamente os valores setados, sem
   * normalizar para [0, 360]. Se a última alteração foi via `rotation`
   * (quaternion), devolve ângulos canônicos derivados dele.
   */
  get eulerAngles(): Vec3 {
    if (!this._eulerInSync) {
      quatToEulerDegrees(this._rotation, this._euler);
      this._eulerInSync = true;
    }
    return vec3.clone(this._euler);
  }

  set eulerAngles(degrees: Vec3) {
    // Guarda os valores crus para leitura fiel e sincroniza o quaternion,
    // que é o que o resto do sistema consome.
    vec3.copy(degrees, this._euler);
    quat.fromEuler(
      degrees[0] * DEG_TO_RAD,
      degrees[1] * DEG_TO_RAD,
      degrees[2] * DEG_TO_RAD,
      EULER_ORDER,
      this._rotation,
    );
    this._eulerInSync = true;
  }

  // --- clonagem ---

  /**
   * Copia a transformação LOCAL de `src` para este nó (posição, escala,
   * rotação), preservando o estado CRU de Euler — o `(500, -720)` contínuo
   * que passar pelo setter de `rotation` perderia. Usada pela clonagem de
   * prefab; não toca em pai/filhos nem em componentes (renderable/camera).
   */
  copyLocalFrom(src: Node): void {
    vec3.copy(src.position, this.position);
    vec3.copy(src.scale, this.scale);
    quat.copy(src._rotation, this._rotation);
    vec3.copy(src._euler, this._euler);
    this._eulerInSync = src._eulerInSync;
  }

  // --- hierarquia ---

  /** Pai deste nó, ou `null` se for um nó de raiz. */
  get parent(): Node | null {
    return this._parent;
  }

  /** Filhos diretos. Somente leitura — use `setParent`/`addChild` para alterar. */
  get children(): readonly Node[] {
    return this._children;
  }

  /**
   * Torna este nó filho de `newParent`, ou o desanexa se `null`.
   *
   * Remove o nó da lista de filhos do pai anterior, mantendo as duas
   * pontas da relação consistentes. Lança erro se `newParent` for o
   * próprio nó ou um descendente dele (o que criaria um ciclo).
   */
  setParent(newParent: Node | null): void {
    if (newParent === this._parent) {
      return;
    }
    // Sobe a cadeia de ancestrais do novo pai; se este nó aparecer lá,
    // a operação criaria um ciclo (inclui o caso newParent === this).
    for (let a = newParent; a !== null; a = a._parent) {
      if (a === this) {
        throw new Error("Cannot parent a node to itself or one of its descendants.");
      }
    }
    if (this._parent) {
      const siblings = this._parent._children;
      siblings.splice(siblings.indexOf(this), 1);
    }
    this._parent = newParent;
    newParent?._children.push(this);
  }

  /** Atalho para `child.setParent(this)`. */
  addChild(child: Node): void {
    child.setParent(this);
  }

  /** Desanexa `child` se ele for filho direto deste nó; senão, não faz nada. */
  removeChild(child: Node): void {
    if (child._parent === this) {
      child.setParent(null);
    }
  }

  /**
   * Rotaciona o nó para que seu eixo **-Z** aponte para `target` (coords de
   * mundo), com o +Y alinhado a `up` tanto quanto possível. A posição não
   * muda.
   *
   * -Z é a convenção de câmera do glTF/WebGPU: com ela, a view matrix sai
   * direto da inversa da matriz de mundo. (Atenção: é o oposto da Unity,
   * onde LookAt aponta o +Z.)
   *
   * A conversão mundo→local assume que a cadeia de pais não tem escala
   * não-uniforme (escala uniforme é ok).
   */
  lookAt(target: Vec3, up: Vec3 = vec3.create(0, 1, 0)): void {
    const world = this.getWorldMatrix();
    const eye = vec3.create(world[12], world[13], world[14]);
    // cameraAim monta a matriz de modelo de "algo em eye olhando target
    // pelo -Z" — a rotação de mundo que queremos, já ortonormal.
    const worldRot = quat.fromMat(mat4.cameraAim(eye, target, up));
    if (this._parent) {
      // rotação local = inversa da rotação de mundo do pai * rotação desejada
      const parentRot = quat.fromMat(normalizeBasis(this._parent.getWorldMatrix()));
      quat.mul(quat.inverse(parentRot, parentRot), worldRot, worldRot);
    }
    this.rotation = worldRot; //o setter normaliza e invalida o cache de Euler
  }

  // --- matrizes ---

  /**
   * Matriz de transformação local: translação * rotação * escala
   * (a escala é aplicada primeiro ao vetor, depois a rotação, depois a
   * translação).
   */
  getLocalMatrix(dst?: Mat4): Mat4 {
    const m = mat4.fromQuat(this._rotation, dst);
    // Índices 12–14 = componente de translação (layout column-major).
    m[12] = this.position[0];
    m[13] = this.position[1];
    m[14] = this.position[2];
    // mat4.scale multiplica pela direita: resultado final é T * R * S.
    return mat4.scale(m, this.scale, m);
  }

  /**
   * Matriz de mundo CACHEADA — o jeito barato de ler, O(1).
   *
   * É atualizada uma vez por frame pela travessia do World.update
   * (top-down, O(n) no total). O contrato: ela é válida DEPOIS do update
   * do frame corrente; quem mexer no transform depois do update e ler no
   * mesmo frame vê o valor do frame anterior. Nó solto (fora da árvore
   * do World) nunca é atualizado.
   *
   * É mutada no lugar a cada frame — não guarde a referência esperando
   * um snapshot; copie se precisar.
   */
  readonly worldMatrix: Mat4 = mat4.identity();

  /**
   * Recalcula `worldMatrix` assumindo que a do pai já foi atualizada
   * neste frame. É o passo da travessia do World — código de jogo
   * normalmente não chama isto.
   */
  updateWorldMatrix(): void {
    this.getLocalMatrix(this.worldMatrix);
    if (this._parent) {
      mat4.multiply(this._parent.worldMatrix, this.worldMatrix, this.worldMatrix);
    }
  }

  /**
   * Matriz do espaço local para o espaço do mundo, recalculada NA HORA
   * subindo a cadeia de pais — O(profundidade) por chamada, sempre fresca.
   * Use quando precisar do valor exato fora do ciclo do frame (ex.: logo
   * após um setParent no createWorld); no caminho quente do frame, leia
   * `worldMatrix`.
   */
  getWorldMatrix(dst?: Mat4): Mat4 {
    const local = this.getLocalMatrix(dst);
    return this._parent
      ? mat4.multiply(this._parent.getWorldMatrix(), local, local)
      : local;
  }
}

/**
 * Normaliza no lugar os três eixos da base de uma mat4, removendo a escala
 * para que quat.fromMat leia só a rotação. (Layout column-major: colunas
 * 0-2 são os eixos X/Y/Z.)
 */
function normalizeBasis(m: Mat4): Mat4 {
  for (let c = 0; c < 3; c++) {
    const i = c * 4;
    const len = Math.hypot(m[i], m[i + 1], m[i + 2]);
    if (len > 0) {
      m[i] /= len;
      m[i + 1] /= len;
      m[i + 2] /= len;
    }
  }
  return m;
}

/**
 * Extrai ângulos de Euler em graus (convenção EULER_ORDER, R = Ry*Rx*Rz)
 * de um quaternion unitário. Resultado canônico: x em [-90, 90],
 * y e z em [-180, 180].
 *
 * As expressões `2 * (...)` são elementos da matriz de rotação equivalente
 * ao quaternion, dos quais os ângulos saem por asin/atan2.
 */
function quatToEulerDegrees(q: Quat, dst: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // Seno do ângulo X. |sinX| ≈ 1 é gimbal lock: olhando reto para
  // cima/baixo, os giros de y e z acontecem em torno do mesmo eixo e
  // deixam de ser distinguíveis.
  const sinX = 2 * (w * x - y * z);
  if (Math.abs(sinX) < 0.9999999) {
    dst[0] = Math.asin(sinX) * RAD_TO_DEG;
    dst[1] = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) * RAD_TO_DEG;
    dst[2] = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)) * RAD_TO_DEG;
  } else {
    // Gimbal lock: fixa z = 0 por convenção e atribui todo o giro
    // restante a y (mesma escolha da Unity e do three.js).
    dst[0] = sinX > 0 ? 90 : -90;
    dst[1] = Math.atan2(2 * (w * y - x * z), 1 - 2 * (y * y + z * z)) * RAD_TO_DEG;
    dst[2] = 0;
  }
  return dst;
}
