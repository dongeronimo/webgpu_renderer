import { initWebGPU } from "./gpu";
import { FinalRenderPass } from "./finalPass";

const status = document.getElementById("status")!;

async function main() {
  const { adapter, device } = await initWebGPU();

  const info = adapter.info;
  status.textContent = `device ready — ${info.vendor} ${info.architecture}`;
  console.log("GPU device ready:", device);
  console.log("Adapter info:", info);
  console.log("Limits:", device.limits);

  //A queue roda os comandos
  const queue = device.queue;
  //Qual é o formato preferido do browser onde estou rodando?
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
  const finalPass = new FinalRenderPass(device, canvas, canvasFormat);

  //Loop de animação: o browser chama frame() a cada vsync (~60x/s),
  //passando um timestamp em ms. Cada chamada agenda a próxima.
  let lastTime = 0;
  function frame(time: number) {
    const deltaTime = (time - lastTime) / 1000; //segundos desde o frame anterior
    lastTime = time;
    //TODO: update usando deltaTime
    //O encoder conterá os comandos
    const encoder = device.createCommandEncoder();
    //TODO: passes intermediários antes do final
    finalPass.render(encoder);
    queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err: Error) => {
  status.textContent = err.message;
  console.error(err);
});
