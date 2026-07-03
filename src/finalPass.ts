//Pass final: compõe o resultado dos outros passes e apresenta na tela.
//Por enquanto só faz o clear do backbuffer.
//
//Em WebGPU não existe swapchain explícita: o GPUCanvasContext cuida disso.
//Você configura o context uma vez (device + formato) e, a cada frame,
//context.getCurrentTexture() devolve a textura da swapchain daquele frame.
//Ela só vale até o fim do frame — por isso pegamos uma nova a cada render().
export class FinalRenderPass {
  private context: GPUCanvasContext;
  private canvas: HTMLCanvasElement;

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
  }

  //Mantém o backbuffer do tamanho real do canvas na tela (CSS px * DPR).
  //getCurrentTexture() sempre segue canvas.width/height.
  //TODO implementar resize
  private resizeIfNeeded(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(encoder: GPUCommandEncoder): void {
    this.resizeIfNeeded();

    //A "imagem da swapchain" deste frame:
    const backbuffer = this.context.getCurrentTexture();

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: backbuffer.createView(),
          loadOp: "clear", //limpa antes de desenhar
          clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue: se aparecer, o pass funciona
          storeOp: "store", //guarda o resultado (senão descarta)
        },
      ],
    });

    //TODO: aqui entra a composição dos outros render passes

    pass.end();
  }
}
