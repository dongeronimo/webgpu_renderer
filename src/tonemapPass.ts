//TonemapPass: como o FinalRenderPass (finalPass.ts), compõe a textura de cor
//de um mesh pass no backbuffer com um triângulo fullscreen — mas em vez de
//copiar o pixel cru, aplica uma curva de tonemap antes de escrever.
//
//Pra isso fazer sentido, `source` precisa ser HDR de verdade: uma textura
//float (ex.: rgba16float) onde a luz pode passar de 1.0 sem ser clampada no
//meio do caminho. Se o mesh pass ainda escreve num alvo 8-bit unorm, o clip
//já aconteceu ali e não tem tonemap que desfaça.
//
//Curva: Reinhard simples (color / (color + 1)) — comprime [0,∞) pra [0,1)
//preservando a proporção entre canais, então luz que estourava vira um
//"quase branco" suave em vez de um clip duro. É o ponto de partida mais
//barato pra validar o pipeline (alvo HDR + pass de tonemap); trocar por ACES
//ou adicionar exposure é um passo de cima, não deste arquivo.
//
//Infra genérica da engine: por enquanto só o GauntletWorld usa (troca do
//FinalRenderPass dele) — os outros mundos continuam no blit direto.
import { gpuTimer } from "./gpuTimer";

const TONEMAP_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = positions[i];
  var out: VsOut;
  out.pos = vec4f(p, 0.0, 1.0);
  //mesma convenção de uv do FinalRenderPass — ver o comentário lá.
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let hdr = textureSample(source, samp, in.uv);
  let mapped = hdr.rgb / (hdr.rgb + vec3f(1.0));
  return vec4f(mapped, hdr.a);
}
`;

export class TonemapPass {
  private context: GPUCanvasContext;
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;

  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private bindGroup: GPUBindGroup | null = null;
  private lastSource: GPUTextureView | null = null;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    format: GPUTextureFormat,
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("Não foi possível obter o contexto WebGPU do canvas.");
    }
    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });
    this.context = context;
    this.canvas = canvas;
    this.device = device;

    this.bindGroupLayout = device.createBindGroupLayout({
      label: "tonemap pass source",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.sampler = device.createSampler({
      label: "tonemap pass sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const module = device.createShaderModule({ label: "tonemap pass reinhard", code: TONEMAP_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "tonemap pass reinhard",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
    });
  }

  //Mantém o backbuffer do tamanho real do canvas na tela (CSS px * DPR).
  resizeIfNeeded(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Tonemapeia `source` (alvo HDR de um mesh pass) e compõe no backbuffer deste frame. */
  render(encoder: GPUCommandEncoder, source: GPUTextureView): void {
    if (source !== this.lastSource) {
      this.bindGroup = this.device.createBindGroup({
        label: "tonemap pass source",
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: source },
          { binding: 1, resource: this.sampler },
        ],
      });
      this.lastSource = source;
    }

    const backbuffer = this.context.getCurrentTexture();

    const pass = encoder.beginRenderPass({
      label: "tonemap pass",
      timestampWrites: gpuTimer.timestampWrites("final"),
      colorAttachments: [
        {
          view: backbuffer.createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
  }

  /** Solta o canvas — mesmo motivo do FinalRenderPass.destroy(). */
  destroy(): void {
    this.context.unconfigure();
    this.bindGroup = null;
    this.lastSource = null;
  }
}
