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
import { usePolled } from "./usePolled";
import { TextureStackVolumeRenderUIRoot } from "./TextureStackVolumeRenderUIRoot";

//export: componente do mundo solar, fora de uso enquanto o mundo ativo é o
//VR — o export evita o erro de "não usado" e ele volta quando o mundo voltar
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

//export pelo mesmo motivo do TerraPositionTable
export function HelloButton() {
    const dispatch = useDispatch<AppDispatch>();
    const clickCount = useSelector((state: RootState) => state.hello.clickCount);
    return (
        <button style={{ marginTop: 8 }} onClick={() => dispatch(helloClicked())}>
            Hello Terra ({clickCount})
        </button>
    );
}

//world com _ enquanto a UI do VR não lê o scene graph (o prop continua
//chegando do mountUi — quando precisar, é só tirar o _)
export function App({ world: _world }: { world: World }) {
    return (
        //pointerEvents:"auto" religa o mouse SÓ neste painel — o resto do
        //overlay (#ui-root, pointer-events:none) deixa o clique atravessar
        //até o canvas
        <div
            style={{
                position: "absolute",
                top: 8,
                right: 8,
                pointerEvents: "auto",
                background: "rgba(0, 0, 0, 0.6)",
                color: "#ddd",
                font: "12px monospace",
                padding: 12,
                borderRadius: 8,
            }}
        >
            <TextureStackVolumeRenderUIRoot/>
            
        </div>
    );
}
