import { initWebGPU } from "./gpu";
import { FinalRenderPass } from "./finalPass";
import { MeshRenderPass } from "./meshPass";
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
  const finalPass = new FinalRenderPass(device, canvas, canvasFormat);
  const meshPass = new MeshRenderPass(device, canvasFormat);

  //const testWorld = new TestWorld(device);
  //await testWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
  
  const solarSystem = new SolarSystem(device);
  await solarSystem.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});

  //Loop de animação: o browser chama frame() a cada vsync (~60x/s),
  //passando um timestamp em ms. Cada chamada agenda a próxima.
  let lastTime = 0;
  function frame(time: number) {
    const deltaTime = (time - lastTime) / 1000; //segundos desde o frame anterior
    solarSystem.update(deltaTime);
    lastTime = time;
    //Resize primeiro, pra mesh pass e final pass verem o mesmo tamanho
    finalPass.resizeIfNeeded();
    const encoder = device.createCommandEncoder();//O encoder conterá os comandos
    //Cena → alvo offscreen do mesh pass (agrupa, envia buffers, desenha)
    meshPass.render(encoder, solarSystem.root, canvas.width, canvas.height);
    //Composição do offscreen no backbuffer
    finalPass.render(encoder, meshPass.colorView);
    queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err: Error) => {
  status.textContent = err.message;
  console.error(err);
});
