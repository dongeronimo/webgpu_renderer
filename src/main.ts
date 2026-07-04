import { initWebGPU } from "./gpu";
import { registerBehaviour } from "./behaviour";
import { RotationBehaviour } from "./rotation_behaviour";
import { SolRotationBehaviour } from "./solarSystem/sunRotationBehaviour";
import { SolarSystem } from "./solarSystem/solarSystemWorld";
import { SetSunColourBehaviour } from "./solarSystem/setSunColourBehaviour";
import { TerraTranslationBehaviour } from "./solarSystem/terraTranslationBehaviour";
import { MoonTranslationBehaviour } from "./solarSystem/moonTranslationBehaviour";
import { TerraRotationBehaviour } from "./solarSystem/terraRotationBehaviour";
const status = document.getElementById("status")!;
// Todas as behaviours que o sistema for usar tem que ser registradas aqui devido
// a falta de reflection de verdade depois da minificaçaõ, que caga os nomes das
// coisas.
function registerBehaviours() {
  registerBehaviour("rotationBehaviour", RotationBehaviour);
  registerBehaviour("solRotation", SolRotationBehaviour);
  registerBehaviour("sunColour", SetSunColourBehaviour);
  registerBehaviour("terraTranslation", TerraTranslationBehaviour);
  registerBehaviour("moonTranslation", MoonTranslationBehaviour);
  registerBehaviour("terraRotation", TerraRotationBehaviour);
}

async function main() {
  const { adapter, device } = await initWebGPU();
  const info = adapter.info;
  status.textContent = `device ready — ${info.vendor} ${info.architecture}`;
  console.log("GPU device ready:", device);
  console.log("Adapter info:", info);
  console.log("Limits:", device.limits);
  //Registra as behaviours, tem que fazer essa gambi pq n tem reflection de verdade depois da minificaçao
  registerBehaviours();

  //A queue roda os comandos
  const queue = device.queue;
  //Qual é o formato preferido do browser onde estou rodando?
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;

  //O mundo é dono da própria cadeia de render passes: primeiro a infra de
  //renderização (createRenderPasses), depois o conteúdo (createWorld).
  //Trocar de "fase" = destroy() neste mundo e repetir os três passos noutro.
  const solarSystem = new SolarSystem(device);
  solarSystem.createRenderPasses(canvas, canvasFormat);
  await solarSystem.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});

  //Loop de animação: o browser chama frame() a cada vsync (~60x/s),
  //passando um timestamp em ms. Cada chamada agenda a próxima.
  let lastTime = 0;
  function frame(time: number) {
    const deltaTime = (time - lastTime) / 1000; //segundos desde o frame anterior
    solarSystem.update(deltaTime);
    lastTime = time;
    const encoder = device.createCommandEncoder();//O encoder conterá os comandos
    //O mundo grava sua sequência de passes; o main só faz encoder/submit
    solarSystem.render(encoder);
    queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err: Error) => {
  status.textContent = err.message;
  console.error(err);
});
