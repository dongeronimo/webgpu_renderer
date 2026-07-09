//Overlay do debug de chunks: blita a textura do DebugChunksPass num quadzinho
//no canto INFERIOR DIREITO, POR CIMA do que o FinalRenderPass já compôs
//(loadOp "load"). Clone do DebugOverlayPass do mundo CT — igual, só muda o
//canto (o do CT é superior direito) — pra não mexer no world CT (baseline
//intacto). Inferior DIREITO de propósito: o painel Desempenho fica no inferior
//esquerdo.
import { gpuTimer } from "../gpuTimer";

const OVERLAY_WGSL = /* wgsl */ `
const F = 0.28; //tamanho do quad, fração da tela
const M = 0.02; //margem até a borda

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let xr = 1.0 - 2.0 * M;   //borda direita do quad, em NDC
    let xl = xr - 2.0 * F;    //borda esquerda
    let yb = -1.0 + 2.0 * M;  //base (NDC y = -1 é embaixo)
    let yt = yb + 2.0 * F;    //topo do quad
    var pos = array<vec2f, 6>(
        vec2f(xl, yt), vec2f(xl, yb), vec2f(xr, yt),
        vec2f(xr, yt), vec2f(xl, yb), vec2f(xr, yb),
    );
    //v=0 no topo: a linha 0 da textura é o topo do framebuffer do debug pass
    var uv = array<vec2f, 6>(
        vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0),
        vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    );
    var out: VsOut;
    out.position = vec4f(pos[i], 0.0, 1.0);
    out.uv = uv[i];
    return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    return textureSample(source, samp, in.uv);
}
`;

export class DebugChunksOverlayPass {
    private readonly device: GPUDevice;
    private readonly context: GPUCanvasContext;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    private bindGroup: GPUBindGroup | null = null;
    private lastSource: GPUTextureView | null = null;

    constructor(device: GPUDevice, canvas: HTMLCanvasElement, format: GPUTextureFormat) {
        this.device = device;
        //o MESMO context do FinalRenderPass (getContext devolve o mesmo objeto);
        //não reconfigura — só desenha por cima do backbuffer já composto
        const context = canvas.getContext("webgpu");
        if (!context) {
            throw new Error("DebugChunksOverlayPass: sem contexto WebGPU do canvas.");
        }
        this.context = context;
        this.sampler = device.createSampler({
            label: "debug chunks overlay sampler",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        this.bindGroupLayout = device.createBindGroupLayout({
            label: "debug chunks overlay source",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
        });
        const module = device.createShaderModule({ label: "debug chunks overlay", code: OVERLAY_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "debug chunks overlay",
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
    }

    render(encoder: GPUCommandEncoder, source: GPUTextureView): void {
        if (source !== this.lastSource) {
            this.bindGroup = this.device.createBindGroup({
                label: "debug chunks overlay source",
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: source },
                ],
            });
            this.lastSource = source;
        }
        const backbuffer = this.context.getCurrentTexture();
        const pass = encoder.beginRenderPass({
            label: "debug chunks overlay pass",
            timestampWrites: gpuTimer.timestampWrites("debugChunksOverlay"),
            colorAttachments: [
                {
                    view: backbuffer.createView(),
                    loadOp: "load", //preserva o volume já composto pelo final pass
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup!);
        pass.draw(6);
        pass.end();
    }

    destroy(): void {
        //nada de GPU próprio (o context é do FinalRenderPass); solta o cache
        this.bindGroup = null;
        this.lastSource = null;
    }
}
