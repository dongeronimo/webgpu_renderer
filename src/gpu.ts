export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
}

export async function initWebGPU(): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported in this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("No suitable GPU adapter found.");
  }

  //timestamp-query: medir tempo de GPU por pass (gpuTimer). Opcional —
  //sem ela o contador de fps só não mostra os tempos de GPU.
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
  });

  device.lost.then((info) => {
    console.error(`GPU device lost (${info.reason}): ${info.message}`);
  });

  device.addEventListener("uncapturederror", (event) => {
    console.error("Uncaptured WebGPU error:", event.error.message);
  });

  return { adapter, device };
}
