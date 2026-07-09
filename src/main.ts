import { initWebGPU } from "./gpu";
import { gpuTimer } from "./gpuTimer";
import { mountUi } from "./ui/mountUi";
import { registerBehaviour } from "./behaviour";
import { RotationBehaviour } from "./rotation_behaviour";
import { SolRotationBehaviour } from "./solarSystem/sunRotationBehaviour";
// import { SolarSystem } from "./solarSystem/solarSystemWorld"; //mundo anterior, ver bloco comentado abaixo
import { SetSunColourBehaviour } from "./solarSystem/setSunColourBehaviour";
import { TerraTranslationBehaviour } from "./solarSystem/terraTranslationBehaviour";
import { MoonTranslationBehaviour } from "./solarSystem/moonTranslationBehaviour";
import { TerraRotationBehaviour } from "./solarSystem/terraRotationBehaviour";
import { TextureStackVolumeRendererSynthetic } from "./textureStackVolumeRenderSynthetic/textureStackVRWorldSynthetic";
import { WorldName } from "./redux/actions";
import { store } from "./redux/store";
import { World } from "./world";
import { SolarSystem } from "./solarSystem/solarSystemWorld";
import { TextureStackVolumeRendererCT } from "./textureStackVolumeRenderCT/textureStackVolumeRenderCTWorld";
import { StarshipDemoWorld } from "./StarshipDemo/StarshipDemoWorld";
import { RaycastWorld } from "./raycast/raycastWorld";
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
  gpuTimer.init(device); //timestamps de GPU por pass (no-op sem a feature)
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
  // const solarSystem = new SolarSystem(device);
  // solarSystem.createRenderPasses(canvas, canvasFormat);
  // await solarSystem.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});

  let currentWorld:World;
  
  const textureVRWorld = new TextureStackVolumeRendererSynthetic(device);
  textureVRWorld.createRenderPasses(canvas,  canvasFormat);
  await textureVRWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
  //UI React no overlay por cima do canvas; recebe o mundo pra poder ler
  //o scene graph (usePolled). O outro canal, UI→engine, é o store redux.
  //mountUi monta o root React uma única vez; setUiWorld aponta a UI pro
  //mundo ativo — na troca, é só chamar de novo com o mundo novo.
  const setUiWorld = mountUi(document.getElementById("ui-root")!);
  setUiWorld(textureVRWorld);

  currentWorld = textureVRWorld;
  //Loop de animação: o browser chama frame() a cada vsync (~60x/s),
  //passando um timestamp em ms. Cada chamada agenda a próxima.
  let lastTime = 0;

  let lastSeenWorld: WorldName = store.getState().base.currentWorld;
  
  async function frame(time: number) {
    // Controla a troca de mundo de acordo com os bts no WorldSwitch.
    const chosenWorld = store.getState().base.currentWorld;
    if (chosenWorld !== lastSeenWorld) {
      lastSeenWorld = chosenWorld;
      console.log("mundo escolhido mudou para:", chosenWorld);
      currentWorld.destroy();
      //nos cases: criar o mundo novo e aí currentWorld = novo; setUiWorld(novo);
      try{
         switch(chosenWorld) {
           case "solarSystem":
              const solarSystem = new SolarSystem(device);
              solarSystem.createRenderPasses(canvas, canvasFormat);
              await solarSystem.createWorld(
                {aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
              currentWorld = solarSystem;
           break;
           case "textureStackVolumeRenderSynthetic":
              const textureVRSynthWorld = new TextureStackVolumeRendererSynthetic(device);
              textureVRSynthWorld.createRenderPasses(canvas,  canvasFormat);
              await textureVRSynthWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
              currentWorld = textureVRSynthWorld;
              break;
           case "textureStackVolumeRenderCT":
              const textureVRCTWorld = new TextureStackVolumeRendererCT(device);
              textureVRCTWorld.createRenderPasses(canvas,  canvasFormat);
              await textureVRCTWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
              currentWorld = textureVRCTWorld;
              break;
            case "StarshipDemo":
              const starshipWorld = new StarshipDemoWorld(device);
              starshipWorld.createRenderPasses(canvas,  canvasFormat);
              await starshipWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
              currentWorld = starshipWorld;
              break;
            case "raycast":
              const raycastWorld = new RaycastWorld(device);
              raycastWorld.createRenderPasses(canvas,  canvasFormat);
              await raycastWorld.createWorld({aspect:canvas.width/canvas.height, fovy:45, near:0.1, far:100});
              currentWorld = raycastWorld;
              break;
         }
         setUiWorld(currentWorld);
      }catch(e){
         console.error(e);
         status.textContent = `falha criando mundo "${chosenWorld}": ${(e as Error).message}`;
         return; //para o loop — não há mundo válido pra continuar renderizando
      }
      lastTime = performance.now(); //zera o relógio: o tempo de carga não é deltaTime
      requestAnimationFrame(frame);
    }
    else {
       const deltaTime = (time - lastTime) / 1000; //segundos desde o frame anterior
       gpuTimer.beginFrame(); //zera os slots de timestamp e conta o fps
       currentWorld.update(deltaTime);
       lastTime = time;
       const encoder = device.createCommandEncoder();//O encoder conterá os comandos
       //O mundo grava sua sequência de passes; o main só faz encoder/submit
       currentWorld.render(encoder);
       gpuTimer.endFrame(encoder); //resolve as queries — antes do finish
       queue.submit([encoder.finish()]);
       gpuTimer.readback(); //leitura assíncrona do frame medido
       requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
}

main().catch((err: Error) => {
  status.textContent = err.message;
  console.error(err);
});
