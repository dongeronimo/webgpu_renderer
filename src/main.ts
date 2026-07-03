import { initWebGPU } from "./gpu";

const status = document.getElementById("status")!;

async function main() {
  const { adapter, device } = await initWebGPU();

  const info = adapter.info;
  status.textContent = `device ready — ${info.vendor} ${info.architecture}`;
  console.log("GPU device ready:", device);
  console.log("Adapter info:", info);
  console.log("Limits:", device.limits);
}

main().catch((err: Error) => {
  status.textContent = err.message;
  console.error(err);
});
