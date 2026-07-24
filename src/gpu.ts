export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
}

export async function initWebGPU(): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported in this browser.");
  }
  const hasHDR = window.matchMedia("(dynamic-range:high)").matches;
  console.log(`has HDR=${hasHDR}`);
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("No suitable GPU adapter found.");
  }

  //timestamp-query: medir tempo de GPU por pass (gpuTimer). Opcional —
  //sem ela o contador de fps só não mostra os tempos de GPU.
  //
  //maxBufferSize: o default (256 MB) é menor que o staging que o Dawn
  //aloca pra despachar os writeTexture do volume inteiro de uma vez
  //(~370 MB num CT de 738 fatias). Pedimos o máximo do adapter — é só
  //um teto de validação, não uma alocação; e como o valor vem do
  //próprio adapter, nunca pedimos mais do que o hardware suporta.
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => {
    console.error(`GPU device lost (${info.reason}): ${info.message}`);
  });

  device.addEventListener("uncapturederror", (event) => {
    console.error("Uncaptured WebGPU error:", event.error.message);
  });

  return { adapter, device };
}
