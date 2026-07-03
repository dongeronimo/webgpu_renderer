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

  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error(`GPU device lost (${info.reason}): ${info.message}`);
  });

  device.addEventListener("uncapturederror", (event) => {
    console.error("Uncaptured WebGPU error:", event.error.message);
  });

  return { adapter, device };
}
