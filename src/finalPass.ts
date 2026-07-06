//Pass final: compõe o resultado dos outros passes e apresenta na tela.
//Hoje "compor" = copiar a textura de cor do mesh pass pro backbuffer com
//um triângulo fullscreen; quando houver mais passes (volume, UI...), é
//aqui que eles se combinam.
//
//Em WebGPU não existe swapchain explícita: o GPUCanvasContext cuida disso.
//Você configura o context uma vez (device + formato) e, a cada frame,
//context.getCurrentTexture() devolve a textura da swapchain daquele frame.
//Ela só vale até o fim do frame — por isso pegamos uma nova a cada render().

//Triângulo fullscreen clássico: 3 vértices gerados no próprio shader
//(sem vertex buffer) cobrindo a tela inteira. Como o alvo do mesh pass
//tem o mesmo tamanho do backbuffer, a leitura é 1:1 por textureLoad —
//coordenada de pixel direto, sem sampler.
import { gpuTimer } from "./gpuTimer";

const BLIT_WGSL = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let pos = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

@group(0) @binding(0) var source: texture_2d<f32>;

@fragment
fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureLoad(source, vec2i(p.xy), 0);
}
`;

export class FinalRenderPass {
  private context: GPUCanvasContext;
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;

  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  //Bind group cacheado: só é recriado quando a textura de origem muda
  //(o mesh pass recria a dele no resize).
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
      label: "final pass source",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = device.createShaderModule({ label: "final pass blit", code: BLIT_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "final pass blit",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
    });
  }

  //Mantém o backbuffer do tamanho real do canvas na tela (CSS px * DPR).
  //getCurrentTexture() sempre segue canvas.width/height.
  //Pública: o main chama no COMEÇO do frame, antes dos outros passes,
  //pra todo mundo enxergar o mesmo tamanho de canvas.
  resizeIfNeeded(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Compõe `source` (a saída do mesh pass) no backbuffer deste frame. */
  render(encoder: GPUCommandEncoder, source: GPUTextureView): void {
    if (source !== this.lastSource) {
      this.bindGroup = this.device.createBindGroup({
        label: "final pass source",
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: source }],
      });
      this.lastSource = source;
    }

    //A "imagem da swapchain" deste frame:
    const backbuffer = this.context.getCurrentTexture();

    const pass = encoder.beginRenderPass({
      label: "final pass",
      timestampWrites: gpuTimer.timestampWrites("final"),
      colorAttachments: [
        {
          view: backbuffer.createView(),
          //o triângulo fullscreen cobre tudo, então nem precisa de clear
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

  /**
   * Solta o canvas: unconfigure() devolve as texturas da swapchain e
   * libera o canvas pra ser configurado de novo — é o que permite o
   * FinalRenderPass do PRÓXIMO mundo assumir o mesmo canvas na troca.
   */
  destroy(): void {
    this.context.unconfigure();
    this.bindGroup = null;
    this.lastSource = null;
  }
}
