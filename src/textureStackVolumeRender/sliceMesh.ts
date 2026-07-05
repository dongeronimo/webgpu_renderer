//Mesh dinâmica de UMA fatia do volume: o polígono convexo (3 a 6 vértices)
//da interseção plano × caixa do volume, com coordenadas UVW.
//
//Formato de vértice, intercalado: vx vy vz u v w → 24 bytes/vértice.
//A posição está no espaço LOCAL do nó gerador, onde a caixa do volume é
//[-0.5, 0.5]³ por convenção — logo uvw = pos + 0.5. Dimensionar o volume
//(ex.: proporções físicas do exame) é papel do scale do nó gerador.
//
//TOPOLOGIA FIXA: sempre 6 vértices e o fan 0-1-2, 0-2-3, 0-3-4, 0-4-5 —
//o vértice 0 participa de todos os triângulos, o que é válido porque o
//polígono é sempre convexo. Polígono com k < 6 vértices repete o último
//nos slots restantes: triângulo de área zero não gera fragmento nenhum.
//Com isso o index buffer NUNCA muda — só os vértices são reescritos
//(writeBuffer) quando a câmera se move.
import { Mesh, MeshType } from "../mesh";

export class SliceMesh extends Mesh {
    override readonly type = MeshType.VolumeSlice;

    /** Vértices por fatia — o máximo da interseção plano × caixa. */
    static readonly VERTS = 6;
    static readonly FLOATS_PER_VERTEX = 6; //pos(3) + uvw(3)
    static readonly BYTES_PER_VERTEX = SliceMesh.FLOATS_PER_VERTEX * 4;

    //Layout para o pipeline do material das fatias.
    static readonly vertexLayout: GPUVertexBufferLayout = {
        arrayStride: SliceMesh.BYTES_PER_VERTEX,
        attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, //posição local
            { shaderLocation: 1, offset: 12, format: "float32x3" }, //uvw
        ],
    };

    //fan a partir do vértice 0, imutável
    private static readonly FAN_INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);

    private readonly device: GPUDevice;

    constructor(device: GPUDevice, name: string) {
        //nasce com os 6 vértices zerados (tudo no mesmo ponto = área zero,
        //nada desenhado) até o primeiro updateVertices
        super(
            device,
            name,
            new ArrayBuffer(SliceMesh.VERTS * SliceMesh.BYTES_PER_VERTEX),
            SliceMesh.FAN_INDICES,
            SliceMesh.BYTES_PER_VERTEX,
            GPUBufferUsage.COPY_DST, //pra reescrever os vértices em runtime
        );
        this.device = device;
    }

    /** Reescreve os 6 vértices (36 floats, pos+uvw intercalados). */
    updateVertices(data: Float32Array<ArrayBuffer>): void {
        this.device.queue.writeBuffer(
            this.vertexBuffer,
            0,
            data,
            0,
            SliceMesh.VERTS * SliceMesh.FLOATS_PER_VERTEX,
        );
    }
}
