//Malhas com os recursos de GPU. A hierarquia de cena (Node/Renderable) não
//toca em objetos WebGPU — quem cria e guarda os buffers é a Mesh.
//
//Formato de vértice, intercalado num único vertex buffer:
//  StaticMesh:  vx vy vz nx ny nz u v                          → 32 bytes/vértice
//  SkinnedMesh: vx vy vz nx ny nz u v id1..id4 w1..w4          → 64 bytes/vértice
//  SliceMesh:   vx vy vz u v w                                 → 24 bytes/vértice
//(ids de junta como uint32, pesos como float32; SliceMesh mora em
//textureStackVolumeRender/sliceMesh.ts — é específica do VR por fatias)
//
//Os índices são sempre uint32 (o loader converte u8/u16 na carga), então
//o indexFormat é fixo.
import { vec3, type Vec3 } from "wgpu-matrix";

export enum MeshType {
  Static,
  Skinned,
  /** Fatia do VR clássico: posição + UVW, gerada em runtime (SliceMesh). */
  VolumeSlice,
}

export abstract class Mesh {
  abstract readonly type: MeshType;

  readonly name: string;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat = "uint32";

  //AABB LOCAL (espaço de modelo), calculado dos vértices no construtor. A
  //posição está no offset 0 de TODO formato (Static/Skinned/Slice), então o
  //cálculo é o mesmo pra todos. Infra de engine: frustum culling, GI, e a
  //voxelização de obstáculo do fluido. Para o AABB de MUNDO, ver
  //Renderable.worldAABB (transforma estes cantos pela worldMatrix do nó).
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;

  //vertexData já vem intercalado no formato da subclasse.
  //mappedAtCreation evita um writeBuffer na queue: o buffer nasce mapeado,
  //copiamos os bytes e desmapeamos.
  //extraVertexUsage: flags ADICIONAIS pro vertex buffer — mesh dinâmica
  //(SliceMesh) passa COPY_DST pra poder reescrever os vértices depois.
  constructor(
    device: GPUDevice,
    name: string,
    vertexData: ArrayBuffer,
    indices: Uint32Array,
    bytesPerVertex: number,
    extraVertexUsage: GPUBufferUsageFlags = 0,
  ) {
    this.name = name;
    this.vertexCount = vertexData.byteLength / bytesPerVertex;
    this.indexCount = indices.length;

    //AABB local: varre as posições (offset 0, stride = bytesPerVertex).
    const floats = new Float32Array(vertexData);
    const strideF = bytesPerVertex / 4;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.vertexCount; i++) {
      const o = i * strideF;
      const x = floats[o], y = floats[o + 1], z = floats[o + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    this.boundsMin = vec3.create(minX, minY, minZ);
    this.boundsMax = vec3.create(maxX, maxY, maxZ);

    this.vertexBuffer = device.createBuffer({
      label: `${name} (vertices)`,
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | extraVertexUsage,
      mappedAtCreation: true,
    });
    new Uint8Array(this.vertexBuffer.getMappedRange()).set(new Uint8Array(vertexData));
    this.vertexBuffer.unmap();

    this.indexBuffer = device.createBuffer({
      label: `${name} (indices)`,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint32Array(this.indexBuffer.getMappedRange()).set(indices);
    this.indexBuffer.unmap();
  }

  //Libera os buffers na GPU. A mesh fica inutilizável depois disso.
  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
  }
}

export class StaticMesh extends Mesh {
  override readonly type = MeshType.Static;

  static readonly BYTES_PER_VERTEX = 32;

  //Layout para usar na criação dos pipelines que desenham meshes estáticas.
  static readonly vertexLayout: GPUVertexBufferLayout = {
    arrayStride: StaticMesh.BYTES_PER_VERTEX,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" }, //posição
      { shaderLocation: 1, offset: 12, format: "float32x3" }, //normal
      { shaderLocation: 2, offset: 24, format: "float32x2" }, //uv
    ],
  };

  constructor(device: GPUDevice, name: string, vertexData: ArrayBuffer, indices: Uint32Array) {
    super(device, name, vertexData, indices, StaticMesh.BYTES_PER_VERTEX);
  }
}

export class SkinnedMesh extends Mesh {
  override readonly type = MeshType.Skinned;

  static readonly BYTES_PER_VERTEX = 64;

  static readonly vertexLayout: GPUVertexBufferLayout = {
    arrayStride: SkinnedMesh.BYTES_PER_VERTEX,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" }, //posição
      { shaderLocation: 1, offset: 12, format: "float32x3" }, //normal
      { shaderLocation: 2, offset: 24, format: "float32x2" }, //uv
      { shaderLocation: 3, offset: 32, format: "uint32x4" }, //ids das juntas
      { shaderLocation: 4, offset: 48, format: "float32x4" }, //pesos
    ],
  };

  constructor(device: GPUDevice, name: string, vertexData: ArrayBuffer, indices: Uint32Array) {
    super(device, name, vertexData, indices, SkinnedMesh.BYTES_PER_VERTEX);
  }
}
