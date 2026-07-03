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
//
//TODO: skins de verdade (esqueleto, inverseBindMatrices) quando existir
//o sistema de animação — por enquanto só os ids/pesos entram no vértice.
import { WebIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { Node as GltfNode, Primitive as GltfPrimitive } from "@gltf-transform/core";
import { quat, vec3 } from "wgpu-matrix";
import { Node } from "./node";
import { Renderable } from "./renderable";
import { Mesh, StaticMesh, SkinnedMesh } from "./mesh";

export interface GltfLoadResult {
  /** Nós de topo da cena do arquivo (sem pai). */
  roots: Node[];
  /** Todos os nós criados, em ordem de travessia (pais antes dos filhos). */
  nodes: Node[];
  /** Meshes únicas do arquivo, já com os buffers na GPU. */
  meshes: Mesh[];
}

export async function loadGltf(device: GPUDevice, url: string): Promise<GltfLoadResult> {
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

    const t = src.getTranslation();
    const r = src.getRotation();
    const s = src.getScale();
    vec3.set(t[0], t[1], t[2], node.position);
    vec3.set(s[0], s[1], s[2], node.scale);
    node.rotation = quat.fromValues(r[0], r[1], r[2], r[3]);

    const gltfMesh = src.getMesh();
    if (gltfMesh) {
      const meshName = gltfMesh.getName() || String(node.name);
      gltfMesh.listPrimitives().forEach((prim, i) => {
        const mesh = getMesh(prim, meshName);
        if (!mesh) {
          return; //primitive não suportada, já avisada no console
        }
        if (i === 0) {
          node.renderable = new Renderable(mesh);
        } else {
          //Renderable é um por nó: primitives extras viram filhos.
          const extra = new Node();
          extra.name = `${node.name}_prim${i}`;
          extra.renderable = new Renderable(mesh);
          extra.setParent(node);
          nodes.push(extra);
        }
      });
    }

    for (const child of src.listChildren()) {
      convertNode(child).setParent(node);
    }
    return node;
  }

  const roots = scene.listChildren().map(convertNode);
  return { roots, nodes, meshes };
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
