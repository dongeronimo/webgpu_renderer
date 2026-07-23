//Loader de glTF/GLB via @gltf-transform/core.
//
//Converte a cena do arquivo para o nosso grafo de Node, já com os
//Renderables apontando para as Meshes, e devolve também a lista de
//meshes únicas (para você guardar na sua lista permanente). Os
//GPUBuffers de vértice e índice são criados aqui, na carga.
//
//Decisões:
//  - Cada primitive do glTF vira uma Mesh nossa (primitives têm formatos/
//    materiais próprios). Como o Renderable é um por nó, um glTF mesh com
//    N primitives gera N-1 nós filhos extras ("nome_prim1", ...).
//  - Uma primitive compartilhada por vários nós vira UMA Mesh (cache),
//    referenciada por vários Renderables.
//  - Primitive com JOINTS_0 + WEIGHTS_0 vira SkinnedMesh; senão StaticMesh.
//  - NORMAL/TEXCOORD_0 ausentes são preenchidos com zeros (com aviso).
//  - Índices são convertidos para uint32; primitive sem índices ganha a
//    sequência 0..n-1 para o caminho de draw ser sempre indexado.
//  - Skin (esqueleto + inverseBindMatrices): vira um Skin nosso, resolvido
//    numa segunda passada (precisa do mapa glTF-node→Node completo pra achar
//    os Nodes dos ossos) e anexado ao nó que desenha a mesh skinnada.
import { WebIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { Node as GltfNode, Primitive as GltfPrimitive, Skin as GltfSkin } from "@gltf-transform/core";
import { quat, vec3 } from "wgpu-matrix";
import { Node } from "./node";
import { Renderable } from "./renderable";
import { Mesh, MeshType, StaticMesh, SkinnedMesh } from "./mesh";
import { Skin } from "./skin";
import { AnimationClip, type AnimationChannel, type AnimInterp, type AnimPath } from "./animation";
import { createBehaviour } from "./behaviour";
import { getMaterial } from "./material";

export interface GltfLoadResult {
  /** Nós de topo da cena do arquivo (sem pai). */
  roots: Node[];
  /** Todos os nós criados, em ordem de travessia (pais antes dos filhos). */
  nodes: Node[];
  /** Meshes únicas do arquivo, já com os buffers na GPU. */
  meshes: Mesh[];
  /** Skins únicas do arquivo, já com os Nodes dos ossos resolvidos. */
  skins: Skin[];
  /** Clips de animação do arquivo (canais por NOME de osso, sem ref a Node).
   *  Vale pra qualquer esqueleto: arquivos só-de-animação do Mixamo (sem mesh)
   *  E clips que vêm junto da própria mesh (ex.: o ferrolho da AK no mesmo
   *  .glb). O casamento canal→osso é por nome, então não é exclusivo humanoide. */
  animations: AnimationClip[];
}

export interface LoadGltfOptions {
  /**
   * Política de translation nos clips de animação do arquivo. O mecanismo de
   * playback casa canal→osso por NOME (AnimatorBehaviour), então o MESMO clip
   * toca em qualquer instância do mesmo esqueleto sem retargeting real — o
   * preço disso é que translation nem sempre é segura de reaproveitar.
   *
   * `true` (default) = fluxo Mixamo/retargeting: o clip vai tocar num
   *   esqueleto que pode ter proporções/escala diferentes das de quem capturou
   *   a animação (Dmitry ≠ xbot ≠ Nat). Só ROTAÇÃO é segura aí, então TODA
   *   translation é descartada na carga (ver o bloco longo no ponto do strip).
   *   Comportamento histórico e o certo pros bonecos.
   *
   * `false` = o clip toca no PRÓPRIO esqueleto em que foi autorado, no mesmo
   *   arquivo da mesh (arma cuja animação É pura translation — o ferrolho da
   *   AK que vai-e-volta). Sem manter a translation a animação simplesmente
   *   não existe. Use isto ao carregar as armas.
   */
  retarget?: boolean;
}

export async function loadGltf(device: GPUDevice, url: string, options?: LoadGltfOptions): Promise<GltfLoadResult> {
  //Default true = preserva o comportamento antigo (descarta translation) pra
  //todo caller que não passa nada — só a arma opta por `retarget: false`.
  const retarget = options?.retarget ?? true;
  //WebIO resolve .gltf e .glb, buscando buffers/imagens externos
  //relativos à url via fetch. Registrar as extensões Khronos deixa o
  //parser aceitar arquivos que as marcam como obrigatórias (ex.: Blender
  //com luzes exige KHR_lights_punctual) — os dados delas a gente ainda
  //ignora na conversão.
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(url);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) {
    throw new Error(`glTF sem cena: ${url}`);
  }

  const nodes: Node[] = [];
  const meshes: Mesh[] = [];
  //Cache primitive → Mesh: instâncias compartilhadas não sobem duas vezes.
  const meshCache = new Map<GltfPrimitive, Mesh | null>();
  //glTF-node → Node nosso: preenchido na conversão, consumido depois pra
  //resolver os ossos das skins (que são referências a nós).
  const nodeMap = new Map<GltfNode, Node>();
  //Nós que desenham mesh skinnada, com a skin do arquivo que os deforma.
  //Coletado na conversão, resolvido na segunda passada (quando o nodeMap já
  //tem todos os ossos). Um mesh com N primitives gera N nós — todos entram.
  const pendingSkins: { node: Node; gltfSkin: GltfSkin }[] = [];

  function getMesh(prim: GltfPrimitive, fallbackName: string): Mesh | null {
    let mesh = meshCache.get(prim);
    if (mesh === undefined) {
      mesh = buildMesh(device, prim, fallbackName);
      meshCache.set(prim, mesh);
      if (mesh) {
        meshes.push(mesh);
      }
    }
    return mesh;
  }

  function convertNode(src: GltfNode): Node {
    const node = new Node();
    const name = src.getName();
    if (name) {
      node.name = name;
    }
    nodes.push(node);
    nodeMap.set(src, node);

    const t = src.getTranslation();
    const r = src.getRotation();
    const s = src.getScale();
    vec3.set(t[0], t[1], t[2], node.position);
    vec3.set(s[0], s[1], s[2], node.scale);
    node.rotation = quat.fromValues(r[0], r[1], r[2], r[3]);

    //Custom properties do Blender (exporte com Include > Data > Custom
    //Properties marcado). A propriedade "behaviours" — em qualquer caixa —
    //é uma lista de nomes separada por ';' e vira instâncias anexadas
    //ao nó, via registry (createBehaviour lança se o nome não foi
    //registrado no main: erro de conteúdo aparece cedo e com nome).
    node.extras = src.getExtras();
    let materialName: string | null = null;
    for (const [key, value] of Object.entries(node.extras)) {
      const k = key.toLowerCase();
      //"MaterialName" ou "Material" (qualquer caixa): nome do material deste
      //nó, resolvido via registry na hora de criar os renderables abaixo.
      //"Material" é o nome natural que o Blender dá à custom property.
      if (k === "materialname" || k === "material") {
        if (typeof value === "string") {
          materialName = value;
        } else {
          console.warn(`glTF: "${node.name}" tem "${key}" não-string — ignorada`);
        }
        continue;
      }
      //behaviours: aceita singular e plural, em qualquer caixa
      if (k !== "behaviours" && k !== "behaviour") {
        continue;
      }
      if (typeof value !== "string") {
        console.warn(`glTF: "${node.name}" tem "${key}" não-string — ignorada`);
        continue;
      }
      for (const rawName of value.split(";")) {
        const behaviourName = rawName.trim();
        if (!behaviourName) {
          continue; //tolera ";" sobrando, tipo "a;b;"
        }
        const behaviour = createBehaviour(behaviourName);
        behaviour.node = node;
        node.behaviours.push(behaviour);
      }
    }

    //Cria o renderable já com o material resolvido pelo nome (se houver).
    //Nome não registrado só avisa: o renderable fica sem material e o
    //mesh pass desenha no magenta de fallback — erro visível, mundo carrega.
    const makeRenderable = (mesh: Mesh): Renderable => {
      const renderable = new Renderable(mesh);
      if (materialName) {
        const material = getMaterial(materialName);
        if (material) {
          renderable.material = material;
        } else {
          console.warn(
            `glTF: material "${materialName}" não registrado (nó "${node.name}") — vai desenhar em magenta`,
          );
        }
      }
      return renderable;
    };

    const gltfMesh = src.getMesh();
    //Skin do nó (esqueleto que deforma a mesh dele). Anexada na 2ª passada,
    //mas o vínculo nó↔skin é decidido aqui: todo nó gerado por esta mesh
    //(o principal e os _primN) compartilha a mesma skin.
    const gltfSkin = src.getSkin();
    if (gltfMesh) {
      const meshName = gltfMesh.getName() || String(node.name);
      gltfMesh.listPrimitives().forEach((prim, i) => {
        const mesh = getMesh(prim, meshName);
        if (!mesh) {
          return; //primitive não suportada, já avisada no console
        }
        //Só faz sentido anexar skin a quem tem os ids/pesos no vértice.
        const target = (renderableNode: Node) => {
          if (gltfSkin && mesh.type === MeshType.Skinned) {
            pendingSkins.push({ node: renderableNode, gltfSkin });
          }
        };
        if (i === 0) {
          node.renderable = makeRenderable(mesh);
          target(node);
        } else {
          //Renderable é um por nó: primitives extras viram filhos.
          const extra = new Node();
          extra.name = `${node.name}_prim${i}`;
          extra.renderable = makeRenderable(mesh);
          extra.setParent(node);
          nodes.push(extra);
          target(extra);
        }
      });
    }

    for (const child of src.listChildren()) {
      convertNode(child).setParent(node);
    }
    return node;
  }

  const roots = scene.listChildren().map(convertNode);

  //---- 2ª passada: skins ----
  //Agora o nodeMap tem TODOS os nós (inclusive os ossos), então dá pra
  //resolver os esqueletos. Uma Skin por glTF-skin (cacheada): meshes que
  //compartilham o mesmo skin apontam pro mesmo objeto.
  const skinCache = new Map<GltfSkin, Skin>();
  const buildSkin = (gltfSkin: GltfSkin): Skin => {
    let skin = skinCache.get(gltfSkin);
    if (skin) {
      return skin;
    }
    //Os ossos, na ordem do arquivo — é essa ordem que o índice de junta do
    //vértice endereça (JOINTS_0 guarda índices NESTE array, não índices de nó).
    const bones = gltfSkin.listJoints().map((joint) => {
      const node = nodeMap.get(joint);
      if (!node) {
        //Junta fora da cena convertida: não deveria acontecer com glTF válido.
        throw new Error(`glTF: junta "${joint.getName()}" do skin não está na cena.`);
      }
      return node;
    });
    //inverseBindMatrices: accessor de MAT4 float32 (16 floats por osso),
    //column-major como o WebGPU. getArray() devolve a view crua; copio pra
    //um Float32Array próprio, que a Skin passa a possuir.
    const ibmAccessor = gltfSkin.getInverseBindMatrices();
    const ibm = ibmAccessor
      ? new Float32Array(ibmAccessor.getArray() as Float32Array)
      : //Sem inverseBindMatrices o glTF manda assumir identidade (bind = origem).
        identityInverseBinds(bones.length);
    skin = new Skin(bones, ibm);
    skinCache.set(gltfSkin, skin);
    return skin;
  };
  for (const { node, gltfSkin } of pendingSkins) {
    node.skin = buildSkin(gltfSkin);
  }

  //---- 3ª passada: animações ----
  //Cada clip é dado puro: canais endereçam o osso pelo NOME (não por Node),
  //pra tocar em qualquer instância do mesmo esqueleto. Arquivos só-de-anim do
  //Mixamo (sem mesh) caem aqui e retornam meshes/skins vazios.
  const animations = root.listAnimations().map((anim) => {
    const channels: AnimationChannel[] = [];
    let duration = 0;
    for (const ch of anim.listChannels()) {
      const targetNode = ch.getTargetNode();
      const sampler = ch.getSampler();
      const rawPath = ch.getTargetPath();
      //só T/R/S; "weights" (morph targets) não entra no skinning.
      if (!targetNode || !sampler || (rawPath !== "translation" && rawPath !== "rotation" && rawPath !== "scale")) {
        continue;
      }
      //Descarte de translation — SÓ no modo retargeting (ver LoadGltfOptions).
      //Sem retargeting real neste engine (canais casam por NOME e tocam em
      //QUALQUER instância do mesmo esqueleto), reaproveitar um clip num
      //esqueleto de outras proporções só é seguro pra ROTAÇÃO, que independe
      //do tamanho do osso. Translation de um osso NÃO-raiz é o comprimento do
      //segmento (offset até o pai) — personagens com proporções diferentes
      //(Dmitry ≠ xbot ≠ Nat, cada um com seu tamanho de braço/perna) têm bind
      //diferente pra ESSA MESMA translation, e sobrescrever com o valor do
      //clip (proporções de QUEM capturou) estica/encolhe o membro pra bater
      //com o esqueleto ERRADO — testado: chegava a 2× no antebraço do Dmitry.
      //E o osso RAIZ (ROOT_BONE_NAME) não é exceção segura: o valor do clip
      //também carrega a escala do ARMATURE de QUEM capturou (aqui, 0.01) —
      //aplicado cru sobre o Armature do Dmitry (0.0292, ~3× maior) desloca o
      //quadril inteiro por um fator parecido. Custa o bob vertical sutil de
      //"peso" no idle (cosmético; a POSIÇÃO real vem do server via
      //GameLoop/pivot, nunca do Hips) — troca aceitável pra não distorcer o
      //corpo. QUANDO retarget=false (arma tocando no PRÓPRIO esqueleto, ex.: o
      //ferrolho da AK que é pura translation), nada disso vale: o clip nasceu
      //nesse esqueleto, então a translation é mantida — sem ela não há anim.
      if (rawPath === "translation" && retarget) {
        continue;
      }
      const input = sampler.getInput();
      const output = sampler.getOutput();
      if (!input || !output) {
        continue;
      }
      const interp = (sampler.getInterpolation() ?? "LINEAR") as AnimInterp;
      if (interp === "CUBICSPLINE") {
        //applyChannel ainda não trata cubicspline (layout de valores é outro).
        console.warn(`glTF: canal CUBICSPLINE de "${targetNode.getName()}" — tratado como LINEAR, pode ficar errado.`);
      }
      //Cópias próprias das keyframes (o clip passa a possuí-las).
      const times = new Float32Array(input.getArray() as ArrayLike<number>);
      const values = new Float32Array(output.getArray() as ArrayLike<number>);
      channels.push({ boneName: targetNode.getName(), path: rawPath as AnimPath, interp, times, values });
      duration = Math.max(duration, times[times.length - 1] ?? 0);
    }
    return new AnimationClip(anim.getName(), duration, channels);
  });

  return { roots, nodes, meshes, skins: [...skinCache.values()], animations };
}

//Fallback pro skin sem inverseBindMatrices: uma identidade por osso.
function identityInverseBinds(count: number): Float32Array {
  const data = new Float32Array(count * 16);
  for (let j = 0; j < count; j++) {
    data[j * 16 + 0] = 1;
    data[j * 16 + 5] = 1;
    data[j * 16 + 10] = 1;
    data[j * 16 + 15] = 1;
  }
  return data;
}

//Intercala os atributos da primitive no formato das nossas meshes e cria
//os buffers. Retorna null se a primitive não for de triângulos.
function buildMesh(device: GPUDevice, prim: GltfPrimitive, name: string): Mesh | null {
  if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
    console.warn(`glTF: primitive de "${name}" ignorada (modo ${prim.getMode()}, só triângulos são suportados)`);
    return null;
  }
  const position = prim.getAttribute("POSITION");
  if (!position) {
    console.warn(`glTF: primitive de "${name}" ignorada (sem POSITION)`);
    return null;
  }
  const normal = prim.getAttribute("NORMAL");
  const uv = prim.getAttribute("TEXCOORD_0");
  const joints = prim.getAttribute("JOINTS_0");
  const weights = prim.getAttribute("WEIGHTS_0");
  const skinned = joints !== null && weights !== null;

  if (!normal) {
    console.warn(`glTF: "${name}" sem normais — preenchendo com zeros`);
  }

  const vertexCount = position.getCount();
  const floatsPerVertex = skinned ? 16 : 8; //slots de 4 bytes por vértice
  const vertexData = new ArrayBuffer(vertexCount * floatsPerVertex * 4);
  //Duas views no mesmo buffer: floats para pos/normal/uv/pesos,
  //uints para os ids das juntas.
  const f32 = new Float32Array(vertexData);
  const u32 = new Uint32Array(vertexData);

  //getElement em vez de getArray: devolve os valores já desnormalizados
  //quando o accessor guarda inteiros normalizados (uv/pesos em u8/u16).
  const el = [0, 0, 0, 0];
  for (let v = 0; v < vertexCount; v++) {
    const base = v * floatsPerVertex;
    position.getElement(v, el);
    f32[base + 0] = el[0];
    f32[base + 1] = el[1];
    f32[base + 2] = el[2];
    if (normal) {
      normal.getElement(v, el);
      f32[base + 3] = el[0];
      f32[base + 4] = el[1];
      f32[base + 5] = el[2];
    }
    if (uv) {
      uv.getElement(v, el);
      f32[base + 6] = el[0];
      f32[base + 7] = el[1];
    }
    if (skinned) {
      joints.getElement(v, el);
      u32[base + 8] = el[0];
      u32[base + 9] = el[1];
      u32[base + 10] = el[2];
      u32[base + 11] = el[3];
      weights.getElement(v, el);
      f32[base + 12] = el[0];
      f32[base + 13] = el[1];
      f32[base + 14] = el[2];
      f32[base + 15] = el[3];
    }
  }

  //new Uint32Array(typedArray) copia convertendo elemento a elemento,
  //então serve para índices u8/u16/u32 do arquivo.
  const srcIndices = prim.getIndices();
  let indices: Uint32Array;
  if (srcIndices) {
    indices = new Uint32Array(srcIndices.getArray()!);
  } else {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      indices[i] = i;
    }
  }

  return skinned
    ? new SkinnedMesh(device, name, vertexData, indices)
    : new StaticMesh(device, name, vertexData, indices);
}
