//Malhas com os recursos de GPU. A hierarquia de cena (Node/Renderable) não
//toca em objetos WebGPU — quem cria e guarda os buffers é a Mesh.
//
//Formato de vértice, intercalado num único vertex buffer:
//  StaticMesh:  vx vy vz nx ny nz u v                          → 32 bytes/vértice
//  SkinnedMesh: vx vy vz nx ny nz u v id1..id4 w1..w4          → 64 bytes/vértice
//(ids de junta como uint32, pesos como float32)
//
//Os índices são sempre uint32 (o loader converte u8/u16 na carga), então
//o indexFormat é fixo.

export enum MeshType {
  Static,
  Skinned,
}

export abstract class Mesh {
  abstract readonly type: MeshType;

  readonly name: string;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat = "uint32";

  //vertexData já vem intercalado no formato da subclasse.
  //mappedAtCreation evita um writeBuffer na queue: o buffer nasce mapeado,
  //copiamos os bytes e desmapeamos.
  constructor(
    device: GPUDevice,
    name: string,
    vertexData: ArrayBuffer,
    indices: Uint32Array,
    bytesPerVertex: number,
  ) {
    this.name = name;
    this.vertexCount = vertexData.byteLength / bytesPerVertex;
    this.indexCount = indices.length;

    this.vertexBuffer = device.createBuffer({
      label: `${name} (vertices)`,
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
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
