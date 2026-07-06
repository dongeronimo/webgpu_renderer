//Pass de OVERLAY do debug: desenha a textura de cor do DebugSlicesPass como
//um quadzinho no canto da tela (picture-in-picture), POR CIMA do que o
//FinalRenderPass já compôs no backbuffer. É UI de jogo 3D: sem view, sem
//proj — o quad é posicionado direto em clip-space num sub-retângulo do
//canto, e a textura é só amostrada nele.
//
//Fica 100% fora do caminho do volume renderer: não toca no slices pass nem
//no final pass. O mundo só chama .render() DEPOIS do final pass, com
//loadOp "load" pra não apagar o volume que já está no backbuffer.
import { gpuTimer } from "../gpuTimer";

const OVERLAY_WGSL = /* wgsl */ `
//Sub-retângulo do canto SUPERIOR DIREITO. NDC vai de -1 a 1 (largura 2),
//então uma fração f da tela ocupa 2*f em NDC. Mesma fração nos dois eixos:
//como a textura de debug tem o tamanho (logo o aspecto) do canvas, um
//retângulo f×f em NDC preserva o aspecto — a imagem não estica.
const F = 0.28; //tamanho do quad, fração da tela
const M = 0.02; //margem até a borda da tela

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let xr = 1.0 - 2.0 * M;  //borda direita do quad, em NDC
    let xl = xr - 2.0 * F;   //borda esquerda
    let yt = 1.0 - 2.0 * M;  //topo (NDC y cresce pra cima)
    let yb = yt - 2.0 * F;   //base
    //dois triângulos: (TL, BL, TR) e (TR, BL, BR). O uv tem v=0 no topo pra
    //a imagem sair EM PÉ — a linha 0 da textura é o topo do framebuffer
    //renderizado pelo DebugSlicesPass (origem top-left).
    var pos = array<vec2f, 6>(
        vec2f(xl, yt), vec2f(xl, yb), vec2f(xr, yt),
        vec2f(xr, yt), vec2f(xl, yb), vec2f(xr, yb),
    );
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

export class DebugOverlayPass {
    private readonly device: GPUDevice;
    private readonly context: GPUCanvasContext;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    //Bind group cacheado: só recria quando a textura de origem muda (o debug
    //pass recria a dele no resize).
    private bindGroup: GPUBindGroup | null = null;
    private lastSource: GPUTextureView | null = null;

    constructor(device: GPUDevice, canvas: HTMLCanvasElement, format: GPUTextureFormat) {
        this.device = device;
        //O MESMO context que o FinalRenderPass já configurou: getContext
        //("webgpu") devolve sempre o mesmo objeto, e getCurrentTexture() no
        //mesmo frame devolve o mesmo backbuffer — então dá pra desenhar por
        //cima do que o final pass compôs. Não reconfiguramos o context aqui.
        const context = canvas.getContext("webgpu");
        if (!context) {
            throw new Error("DebugOverlayPass: não foi possível obter o contexto WebGPU do canvas.");
        }
        this.context = context;
        this.sampler = device.createSampler({
            label: "debug overlay sampler",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        this.bindGroupLayout = device.createBindGroupLayout({
            label: "debug overlay source",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
        });
        const module = device.createShaderModule({ label: "debug overlay", code: OVERLAY_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "debug overlay",
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
    }

    /** Desenha `source` (a saída do DebugSlicesPass) no canto do backbuffer. */
    render(encoder: GPUCommandEncoder, source: GPUTextureView): void {
        if (source !== this.lastSource) {
            this.bindGroup = this.device.createBindGroup({
                label: "debug overlay source",
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
            label: "debug overlay pass",
            timestampWrites: gpuTimer.timestampWrites("debugOverlay"),
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
        //nada de GPU próprio pra liberar (o context é do FinalRenderPass);
        //só solta o cache pro GC.
        this.bindGroup = null;
        this.lastSource = null;
    }
}
