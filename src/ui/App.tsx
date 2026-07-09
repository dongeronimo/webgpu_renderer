//A UI do overlay. Demonstra os dois fluxos da fronteira:
//  - engine → UI: TerraPositionTable lê a worldMatrix do nó "Terra" por
//    polling (usePolled). O dado vem do scene graph, não do Redux.
//  - UI → engine: HelloButton despacha uma action; a HelloReactBehaviour
//    pendurada no Terra lê o state no update() dela e reage.
import { useDispatch, useSelector } from "react-redux";
import { helloClicked } from "../redux/actions";
import type { RootState } from "../redux/reducers";
import type { AppDispatch } from "../redux/store";
import type { World } from "../world";
import { SolarSystem } from "../solarSystem/solarSystemWorld";
import { TextureStackVolumeRendererSynthetic } from "../textureStackVolumeRenderSynthetic/textureStackVRWorldSynthetic";
import { TextureStackVolumeRendererCT } from "../textureStackVolumeRenderCT/textureStackVolumeRenderCTWorld";
import { usePolled } from "./usePolled";
import { TextureStackVolumeRenderUIRoot } from "./TextureStackVolumeRenderUIRoot";
import TbCTRenderProperties from "./textureBasedCT/tbCTRenderProperties";
import { WorldSwitch } from "./base/WorldSwitch";
import { FloatingPanel } from "./generic/FloatingPanel";
import { GpuStats } from "./GpuStats";
import { RaycastWorld } from "../raycast/raycastWorld";
import { OrbitControls } from "./OrbitControls";
import RaycastRenderProperties from "./raycast/raycastRenderProperties";

export function TerraPositionTable({ world }: { world: World }) {
    //Snapshot da translação global (colunas 12/13/14 da worldMatrix) —
    //array novo a cada leitura, nunca a referência viva da matriz.
    const pos = usePolled(() => {
        const terra = world.findNode("Terra");
        if (!terra) {
            return null;
        }
        const m = terra.worldMatrix;
        return [m[12], m[13], m[14]];
    }, 4);

    if (!pos) {
        return <div>nó "Terra" não encontrado</div>;
    }
    return (
        <table style={{ borderCollapse: "collapse" }}>
            <caption style={{ marginBottom: 4 }}>Terra (world)</caption>
            <tbody>
                {(["x", "y", "z"] as const).map((axis, i) => (
                    <tr key={axis}>
                        <td style={{ paddingRight: 8, opacity: 0.7 }}>{axis}</td>
                        <td style={{ textAlign: "right", minWidth: "6ch" }}>{pos[i].toFixed(2)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export function HelloButton() {
    const dispatch = useDispatch<AppDispatch>();
    const clickCount = useSelector((state: RootState) => state.hello.clickCount);
    return (
        <button style={{ marginTop: 8 }} onClick={() => dispatch(helloClicked())}>
            Hello Terra ({clickCount})
        </button>
    );
}

//UI do mundo solar: os dois componentes-demo num painel próprio.
function SolarSystemUIRoot({ world }: { world: World }) {
    return (
        <FloatingPanel title="Sistema Solar" width={240} height="auto" style={{ top: 8, left: 8 }}>
            <TerraPositionTable world={world} />
            <HelloButton />
        </FloatingPanel>
    );
}

//Qual UI acompanha qual mundo — decidido pela PROP world (instanceof), e
//NÃO pelo currentWorld do redux, de propósito: o redux carrega intenção e
//muda no clique, antes do engine trocar; a prop muda no setUiWorld() do
//main, no mesmo instante em que o mundo novo vira o ativo. Atômico.
function WorldUi({ world }: { world: World }) {
    if (world instanceof TextureStackVolumeRendererSynthetic) {
        return <TextureStackVolumeRenderUIRoot />;
    }
    if (world instanceof SolarSystem) {
        return <SolarSystemUIRoot world={world} />;
    }
    if (world instanceof TextureStackVolumeRendererCT) {
        return <TbCTRenderProperties world={world} />;
    }
    if (world instanceof RaycastWorld) {
        return <RaycastRenderProperties />;
    }
    //mundo sem UI própria: fica só o WorldSwitch na tela
    return null;
}

export function App({ world }: { world: World }) {
    //Sem div posicionado aqui: cada painel é um FloatingPanel que se
    //posiciona sozinho e religa o próprio pointer-events. O WorldSwitch
    //vive FORA do WorldUi porque pertence à app, não a um mundo — ele
    //sobrevive à troca com estado (drag/minimizado) intacto.
    return (
        <>
            {/*captura de mouse pra órbita: PRIMEIRO filho de propósito —
               pinta atrás dos painéis, então drag/scroll no vazio orbitam e
               nos painéis continuam sendo do painel. Só no mundo que orbita.*/}
            {world instanceof RaycastWorld && <OrbitControls />}
            <WorldSwitch />
            {/*desempenho é da app, como o WorldSwitch: é o instrumento de
               comparação ENTRE mundos, sobrevive à troca*/}
            <FloatingPanel title="Desempenho" width={200} height="auto" style={{ bottom: 8, left: 8 }}>
                <GpuStats />
            </FloatingPanel>
            <WorldUi world={world} />
        </>
    );
}
