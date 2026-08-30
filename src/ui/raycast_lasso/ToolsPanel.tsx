//Barra de FERRAMENTAS do mundo do lasso. Uma ferramenta armada por vez —
//a exclusão é do próprio state (tools.activeTool é UM valor), e a UI só a
//espelha num radiogroup.
//
//Por que "Câmera" é um botão de verdade, e não "nenhum botão aceso":
//"none" não é ausência de modo, é o modo em que arrastar ORBITA. Num
//radiogroup existe sempre exatamente um selecionado; deixar o none como
//não-seleção daria um grupo apagado e o usuário sem saber em que modo está.
//Nomeando o modo, o caminho de volta fica óbvio (clicar em Câmera) e o
//grupo fica consistente. Esc é o atalho pro mesmo lugar.
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { setActiveTool, type ToolName } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { FloatingPanel } from "../generic/FloatingPanel";
import { ToolRadioGroup, type ToolRadioItem } from "../generic/ToolRadioGroup";

//Ícones inline (nada de arquivo/lib pra dois desenhos de 16px). currentColor
//pra herdarem a cor do item, inclusive quando ele fica aceso.
function OrbitIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.3">
            <circle cx="8" cy="8" r="2.4" />
            <ellipse cx="8" cy="8" rx="7" ry="3.1" transform="rotate(-28 8 8)" />
        </svg>
    );
}

function LassoIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <ellipse cx="8" cy="6.2" rx="5.6" ry="4.1" />
            <path d="M5.1 9.7c-.6 1.9.3 3.2 1.7 3.9" />
        </svg>
    );
}

//A lista É a fonte da ordem na tela. Tool novo entra aqui e em ToolName.
const TOOLS: readonly ToolRadioItem<ToolName>[] = [
    {
        value: "none",
        label: "Câmera",
        icon: <OrbitIcon />,
        hint: "Arrastar orbita o volume (Esc volta pra cá)",
    },
    {
        value: "lasso",
        label: "Lasso",
        icon: <LassoIcon />,
        hint: "Desenhar um contorno pra remover o que está dentro dele",
    },
];

export default function ToolsPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const activeTool = useSelector((state: RootState) => state.tools.activeTool);

    //Esc desarma. Listener na window (e não no painel) porque a mão do usuário
    //vai estar no canvas, não no painel — o foco quase nunca está aqui. Só
    //existe com alguma tool armada: sem isso, um Esc no mundo do lasso
    //despacharia "none" em cima de "none" a cada tecla.
    useEffect(() => {
        if (activeTool === "none") {
            return;
        }
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                dispatch(setActiveTool("none"));
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [activeTool, dispatch]);

    return (
        <FloatingPanel title="Ferramentas" width={172} height="auto"
            style={{ bottom: 8, left: 220 }}>
            <ToolRadioGroup
                name="raycast-lasso-tool"
                label="Ferramenta ativa"
                items={TOOLS}
                value={activeTool}
                onChange={(tool) => dispatch(setActiveTool(tool))}
            />
            {/*Aviso temporário: com o lasso armado ainda não acontece nada no
               canvas — a captura do traço é a F1. Sai daqui quando ela entrar.*/}
            {activeTool === "lasso" && (
                <p style={{ margin: "8px 0 0", fontSize: 11, opacity: 0.7, lineHeight: 1.35 }}>
                    captura do traço ainda não implementada
                </p>
            )}
        </FloatingPanel>
    );
}
