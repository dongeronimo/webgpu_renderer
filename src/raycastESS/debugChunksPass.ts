//Pass de DEBUG do empty-space skipping: desenha um cubinho por chunk MANTIDO
//(occupied[i] != 0 pra CTF atual), como geometria INSTANCIADA — um único
//drawIndexed com instanceCount = totalChunks. O vertex shader coloca cada
//instância na sua célula da grade dentro da caixa do volume (mesma model
//matrix do volume, então os cubos giram junto com a órbita) e COLAPSA os
//chunks pulados (fora do clip → não rasteriza). É a versão blocada do que
//sobra pra CTF — dá pra VER a estrutura do skip.
//
//NÃO é volume rendering: cubos sólidos com Phong (normal do cubo, luz um pouco
//acima e ao lado da câmera) leem muito melhor que uma nuvem de ocupação. Roda
//num offscreen próprio; o DebugChunksOverlayPass o põe no canto inferior.
//
//Lê o MESMO buffer occupied do VolumeRaycastESSMaterial (uma fonte de verdade —
//atualiza sozinho quando a behaviour refaz o skip-map na mudança de CTF).
import { mat4, type Mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import { Mesh, StaticMesh } from "../mesh";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
//encolhe cada cubo um tico pra chunks vizinhos não se fundirem (vê os cubos)
const CUBE_SHRINK = 0.9;

const CHUNKS_WGSL = /* wgsl */ `
struct U {
    view: mat4x4f,
    proj: mat4x4f,
    model: mat4x4f,     //model matrix do volume (posiciona a grade)
    cameraPos: vec4f,   //xyz + pad
    numChunks: vec4f,   //xyz (f32→u32) + pad
    chunkCell: vec4f,   //tamanho do chunk em uvw por eixo + pad
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> occupied: array<u32>;

fn inverse3(m: mat3x3f) -> mat3x3f {
    let a = m[0]; let b = m[1]; let c = m[2];
    let r0 = cross(b, c); let r1 = cross(c, a); let r2 = cross(a, b);
    let invDet = 1.0 / dot(a, r0);
    return mat3x3f(
        vec3f(r0.x, r1.x, r2.x),
        vec3f(r0.y, r1.y, r2.y),
        vec3f(r0.z, r1.z, r2.z),
    ) * invDet;
}

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) worldNormal: vec3f,
};

@vertex
fn vs(
    @location(0) position: vec3f, //cubo unitário [-0.5,0.5]³
    @location(1) normal: vec3f,
    @builtin(instance_index) inst: u32,
) -> VsOut {
    var out: VsOut;
    let nx = u32(u.numChunks.x);
    let ny = u32(u.numChunks.y);

    //chunk pulado → colapsa fora do clip (área zero, não rasteriza)
    if (occupied[inst] == 0u) {
        out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
        out.worldPos = vec3f(0.0);
        out.worldNormal = vec3f(0.0, 0.0, 1.0);
        return out;
    }

    //desflatten inst → (cx,cy,cz), row-major (z,y,x) igual ao chunkHistogramOffset
    let cx = inst % nx;
    let cy = (inst / nx) % ny;
    let cz = inst / (nx * ny);
    let ci = vec3f(f32(cx), f32(cy), f32(cz));

    let cell = u.chunkCell.xyz;
    let lo = ci * cell;
    let hi = min((ci + vec3f(1.0)) * cell, vec3f(1.0)); //último chunk pode ser parcial
    let center = (lo + hi) * 0.5;
    let sizeUvw = (hi - lo) * ${CUBE_SHRINK};

    //cubo [-0.5,0.5]³ → span do chunk em uvw → local do volume [-0.5,0.5]
    let localPos = (center + position * sizeUvw) - vec3f(0.5);
    let world = u.model * vec4f(localPos, 1.0);
    out.pos = u.proj * u.view * world;
    out.worldPos = world.xyz;
    //normal do cubo pro mundo (faces são eixo-alinhadas: a escala do chunk só
    //reescala, o normalize corrige; a orientação vem da mat3 do model)
    let nm = transpose(inverse3(mat3x3f(u.model[0].xyz, u.model[1].xyz, u.model[2].xyz)));
    out.worldNormal = nm * normal;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //luz um pouco ACIMA e AO LADO da câmera: base na cameraPos + up + right, que
    //saem da base da câmera (transpose(mat3(view)) = eixos-mundo da câmera).
    let camAxes = transpose(mat3x3f(u.view[0].xyz, u.view[1].xyz, u.view[2].xyz));
    let right = camAxes[0];
    let up = camAxes[1];
    let lightPos = u.cameraPos.xyz + up * 1.2 + right * 0.9;

    let N = normalize(in.worldNormal);
    let L = normalize(lightPos - in.worldPos);
    let V = normalize(u.cameraPos.xyz - in.worldPos);
    let H = normalize(L + V);
    let diffuse = max(dot(N, L), 0.0);
    let specular = pow(max(dot(N, H), 0.0), 24.0);
    let ambient = 0.25;
    let base = vec3f(0.85, 0.55, 0.30); //laranja quente
    let rgb = base * (ambient + (1.0 - ambient) * diffuse) + vec3f(0.25 * specular);
    return vec4f(rgb, 1.0);
}
`;

export class DebugChunksPass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    private readonly uniformBuffer: GPUBuffer;
    //60 floats: view(16)+proj(16)+model(16)+cameraPos(4)+numChunks(4)+chunkCell(4)
    private readonly uniformData = new Float32Array(60);

    //bind group cacheado: só recria se o buffer occupied mudar (não muda depois
    //da criação — o material o reescreve no lugar).
    private bindGroup: GPUBindGroup | null = null;
    private lastOccupied: GPUBuffer | null = null;

    private colorTexture: GPUTexture | null = null;
    private depthTexture: GPUTexture | null = null;
    private _colorView: GPUTextureView | null = null;
    private depthView: GPUTextureView | null = null;
    //formato do alvo de cor (o mesmo do pipeline) — a textura offscreen tem que
    //nascer com ele, senão o begin render pass reclama de mismatch
    private readonly colorFormat: GPUTextureFormat;

    constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
        this.device = device;
        this.colorFormat = colorFormat;
        this.bindGroupLayout = device.createBindGroupLayout({
            label: "debug chunks bind group",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });
        const module = device.createShaderModule({ label: "debug chunks", code: CHUNKS_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "debug chunks",
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module, entryPoint: "vs", buffers: [StaticMesh.vertexLayout] },
            fragment: { module, entryPoint: "fs", targets: [{ format: colorFormat }] },
            //cubos sólidos vistos de fora: culla as back-faces (o unitary_cube
            //tem as front-faces pra fora — o raycast usa "front" justamente pra
            //pegar as de trás).
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        });
        this.uniformBuffer = device.createBuffer({
            label: "debug chunks uniform",
            size: this.uniformData.byteLength, //240 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    /** A textura de cor com os cubos — o que o overlay põe no canto. */
    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("DebugChunksPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    render(
        encoder: GPUCommandEncoder,
        camNode: Node,
        model: Mat4,
        cubeMesh: Mesh,
        occupied: GPUBuffer,
        numChunks: readonly [number, number, number],
        chunkCell: readonly [number, number, number],
        width: number,
        height: number,
    ): void {
        this.ensureTargets(width, height);

        //---- uniform ----
        const cw = camNode.worldMatrix;
        this.uniformData.set(mat4.invert(cw), 0);                       //view
        this.uniformData.set(camNode.camera!.getProjectionMatrix(), 16); //proj
        this.uniformData.set(model, 32);                                //model do volume
        this.uniformData[48] = cw[12]; this.uniformData[49] = cw[13]; this.uniformData[50] = cw[14]; //cameraPos
        this.uniformData[52] = numChunks[0]; this.uniformData[53] = numChunks[1]; this.uniformData[54] = numChunks[2];
        this.uniformData[56] = chunkCell[0]; this.uniformData[57] = chunkCell[1]; this.uniformData[58] = chunkCell[2];
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

        //---- bind group (cacheado por buffer occupied) ----
        if (occupied !== this.lastOccupied) {
            this.bindGroup = this.device.createBindGroup({
                label: "debug chunks bind group",
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                    { binding: 1, resource: { buffer: occupied } },
                ],
            });
            this.lastOccupied = occupied;
        }

        const instanceCount = numChunks[0] * numChunks[1] * numChunks[2];
        const pass = encoder.beginRenderPass({
            label: "debug chunks pass",
            timestampWrites: gpuTimer.timestampWrites("debugChunks"),
            colorAttachments: [
                {
                    view: this._colorView!,
                    loadOp: "clear",
                    clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 }, //fundo escuro pros cubos saltarem
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthView!,
                depthLoadOp: "clear",
                depthClearValue: 1.0,
                depthStoreOp: "discard",
            },
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup!);
        pass.setVertexBuffer(0, cubeMesh.vertexBuffer);
        pass.setIndexBuffer(cubeMesh.indexBuffer, cubeMesh.indexFormat);
        //INSTANCING de verdade: um draw, uma instância por chunk
        pass.drawIndexed(cubeMesh.indexCount, instanceCount, 0, 0, 0);
        pass.end();
    }

    destroy(): void {
        this.uniformBuffer.destroy();
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = null;
        this.depthTexture = null;
        this._colorView = null;
        this.depthView = null;
        this.bindGroup = null;
        this.lastOccupied = null;
    }

    ensureTargets(width: number, height: number): void {
        if (this.colorTexture && this.colorTexture.width === width && this.colorTexture.height === height) {
            return;
        }
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = this.device.createTexture({
            label: "debug chunks color",
            size: [width, height],
            format: this.colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "debug chunks depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this.depthView = this.depthTexture.createView();
    }
}
