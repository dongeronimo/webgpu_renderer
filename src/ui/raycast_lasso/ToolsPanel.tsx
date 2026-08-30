//Barra de FERRAMENTAS do mundo do lasso. Uma ferramenta armada por vez —
//a exclusão é do próprio state (tools.activeTool é UM valor), e a UI só a
//espelha num radiogroup.
//
//Por que "Câmera" é um botão de verdade, e não "nenhum botão aceso":
//"none" não é ausência de modo, é o modo em que arrastar ORBITA. Num
//radiogroup existe sempre exatamente um selecionado; deixar o none como
//não-seleção daria um grupo apagado e o usuário sem saber em que modo está.
//Esc é o atalho pro mesmo lugar.
//
//LASSO e BISTURI desenham o mesmo contorno e fazem coisas bem diferentes:
//o lasso fura de ponta a ponta (pirâmide infinita), o bisturi remove só a
//primeira CAMADA de material, com a espessura que ela tem em cada ponto. Por
//isso são dois tools e não um tool com um checkbox — o resultado, o dado e o
//processo são outros.
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { redo, setActiveTool, setLassoDebugView, setScalpelDebugView, setScalpelMargin, undo, type ToolName } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { Button } from "../generic/Button";
import { FloatingPanel } from "../generic/FloatingPanel";
import { Slider } from "../generic/Slider";
import { Toggle } from "../generic/Toggle";
import { ToolRadioGroup, type ToolRadioItem } from "../generic/ToolRadioGroup";

//Ícones inline (nada de arquivo/lib pra três desenhos de 16px). currentColor
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

function ScalpelIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
            strokeLinejoin="round">
            {/*cabo*/}
            <path d="M2.5 13.5 L6.8 9.2" />
            {/*lâmina*/}
            <path d="M6.8 9.2 L11.4 2.6 L13.4 4.6 L9.2 9.2 Z" />
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
        hint: "Remove tudo que está sob o contorno, de ponta a ponta",
    },
    {
        value: "scalpel",
        label: "Bisturi",
        icon: <ScalpelIcon />,
        hint: "Remove a primeira camada de material inteira, com a espessura dela",
    },
];

const HINT_STYLE = { margin: "8px 0 0", fontSize: 11, opacity: 0.7, lineHeight: 1.45 } as const;
const COUNT_STYLE = { margin: "6px 0 0", fontSize: 11, opacity: 0.55 } as const;

export default function ToolsPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const activeTool = useSelector((state: RootState) => state.tools.activeTool);
    //Contagens: ficam no state mesmo depois de soltar a ferramenta — são o
    //documento, não o modo de interação.
    const lassoCount = useSelector((state: RootState) => state.lasso.items.length);
    const scalpelCount = useSelector((state: RootState) => state.scalpel.items.length);
    const margin = useSelector((state: RootState) => state.scalpel.margin);
    //As debug views das DUAS ferramentas moram aqui, e não no painel de render:
    //pertencem à ferramenta, não à técnica. Ficam sempre visíveis (e não só com
    //a ferramenta armada) porque o que elas mostram são os cortes JÁ FEITOS —
    //justamente o que você quer conferir depois de soltar a ferramenta e
    //orbitar.
    const lassoDebugView = useSelector((state: RootState) => state.raycast.lassoDebugView);
    const scalpelDebugView = useSelector((state: RootState) => state.raycast.scalpelDebugView);
    //Só o TAMANHO das pilhas: selecionar os arrays faria a barra re-renderizar
    //a cada empilhada, e o que a UI precisa saber é apenas se dá pra clicar.
    const canUndo = useSelector((state: RootState) => state.history.undo.length > 0);
    const canRedo = useSelector((state: RootState) => state.history.redo.length > 0);

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

    //Ctrl+Z / Ctrl+Y (e Ctrl+Shift+Z, que é o redo do resto do mundo). metaKey
    //junto pra funcionar no Mac. Na window, como o Esc: a mão do usuário está no
    //canvas, não no painel.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (!e.ctrlKey && !e.metaKey) {
                return;
            }
            //Digitando num campo, Ctrl+Z é do campo — não sequestra.
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
                || target.isContentEditable)) {
                return;
            }
            const key = e.key.toLowerCase();
            if (key === "z" && !e.shiftKey) {
                e.preventDefault();
                dispatch(undo());
            } else if (key === "y" || (key === "z" && e.shiftKey)) {
                e.preventDefault();
                dispatch(redo());
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [dispatch]);

    const drawing = activeTool !== "none";

    return (
        <FloatingPanel title="Ferramentas" width={212} height="auto"
            style={{ bottom: 8, left: 220 }}>
            {/*Desfazer/refazer no TOPO: valem pra barra inteira, não pra uma
               ferramenta. Desabilitados com a pilha vazia — é o que diz se há
               algo a desfazer sem precisar de contador na tela.*/}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<span>↶</span>}
                    disabled={!canUndo}
                    title="Desfazer (Ctrl+Z)"
                    style={{ flex: 1 }}
                    onClick={() => dispatch(undo())}
                >
                    Desfazer
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<span>↷</span>}
                    disabled={!canRedo}
                    title="Refazer (Ctrl+Y)"
                    style={{ flex: 1 }}
                    onClick={() => dispatch(redo())}
                >
                    Refazer
                </Button>
            </div>
            <ToolRadioGroup
                name="raycast-lasso-tool"
                label="Ferramenta ativa"
                items={TOOLS}
                value={activeTool}
                onChange={(tool) => dispatch(setActiveTool(tool))}
            />

            {/*MARGEM, e não espessura: a espessura do corte é a da estrutura,
               medida pelo mapa da camada em cada pixel. Este slider só acrescenta
               um tanto além do fim dela — zero é o valor normal. Vale pro PRÓXIMO
               corte; cada bisturi guarda a margem com que foi feito.*/}
            {activeTool === "scalpel" && (
                <div style={{ marginTop: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 11 }}>margem</span>
                        <span style={{ fontSize: 11 }}>{margin.toFixed(3)}</span>
                    </div>
                    <Slider
                        min={0}
                        max={0.1}
                        step={0.005}
                        value={margin}
                        onChange={(value) => dispatch(setScalpelMargin(value))}
                    />
                </div>
            )}

            {/*Controles do traço, iguais nas duas ferramentas — e com qualquer
               uma delas na mão a câmera está congelada (o overlay de captura
               cobre a camada de órbita).*/}
            {drawing && (
                <p style={HINT_STYLE}>
                    arraste com o botão esquerdo pra desenhar<br />
                    botão direito cancela o traço · Esc solta a ferramenta
                </p>
            )}

            {(lassoCount > 0 || scalpelCount > 0) && (
                <p style={COUNT_STYLE}>
                    {lassoCount > 0 && <>{lassoCount} {lassoCount === 1 ? "lasso" : "lassos"}</>}
                    {lassoCount > 0 && scalpelCount > 0 && " · "}
                    {scalpelCount > 0 && <>{scalpelCount} {scalpelCount === 1 ? "bisturi" : "bisturis"}</>}
                </p>
            )}

            {/*Debug views: em vez de remover, PINTAM a região que cada
               ferramenta corta — magenta o lasso, verde-piscina o bisturi (a
               segunda em degradê: claro onde a camada começa, escuro onde
               acaba). Separadas de propósito: dá pra conferir uma enquanto a
               outra corta pra valer.*/}
            <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 8 }}>
                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                    <span>debug view (lasso)</span>
                    <Toggle
                        checked={lassoDebugView}
                        onChange={(value) => dispatch(setLassoDebugView(value))}
                    />
                </label>
                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, marginTop: 4 }}>
                    <span>debug view (bisturi)</span>
                    <Toggle
                        checked={scalpelDebugView}
                        onChange={(value) => dispatch(setScalpelDebugView(value))}
                    />
                </label>
            </div>
        </FloatingPanel>
    );
}
