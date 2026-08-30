//Painel do LASSO: liga o modo de desenho, escolhe a operação do próximo lasso
//e mexe na pilha (desfazer/refazer/limpar).
//
//Undo/redo aqui é barato de verdade: a lista de lassos nunca encolhe, só o
//`cursor` anda. Desfazer não reverte nada no volume — a fonte da verdade é a
//lista, e o corte é 100% recalculado no shader a cada frame.
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { clearLassos, redoLasso, setLassoDrawing, setLassoOp, undoLasso } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import type { LassoOp } from "../../raycastLasso/lasso";
import { FloatingPanel } from "../generic/FloatingPanel";
import { Button } from "../generic/Button";
import { Toggle } from "../generic/Toggle";

const OPS: { value: LassoOp; label: string; hint: string }[] = [
    { value: "remove-inside", label: "remover dentro", hint: "some o que está dentro do traço (vários lassos: união do removido)" },
    { value: "keep-inside", label: "manter dentro", hint: "só sobra o que está dentro do traço (vários lassos: interseção)" },
];

export function LassoPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const drawing = useSelector((state: RootState) => state.lasso.drawing);
    const op = useSelector((state: RootState) => state.lasso.op);
    const total = useSelector((state: RootState) => state.lasso.lassos.length);
    const cursor = useSelector((state: RootState) => state.lasso.cursor);

    //Ctrl+Z / Ctrl+Shift+Z (e Ctrl+Y) globais. Ignora quando o foco está num
    //campo de texto — o editor de CTF tem inputs, e lá o ctrl+z é do browser.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (!e.ctrlKey && !e.metaKey) {
                return;
            }
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
                return;
            }
            const key = e.key.toLowerCase();
            if (key === "z" && !e.shiftKey) {
                e.preventDefault();
                dispatch(undoLasso());
            } else if ((key === "z" && e.shiftKey) || key === "y") {
                e.preventDefault();
                dispatch(redoLasso());
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [dispatch]);

    return (
        <FloatingPanel title="Lasso de remoção" width={260} height="auto" style={{ top: 8, left: 276 }}>
            {/*o modo de desenho troca o OrbitControls pelo LassoOverlay: com ele
               ligado a câmera CONGELA, que é o que faz o corte casar com o traço*/}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>modo desenho</span>
                <Toggle checked={drawing} onChange={(value) => dispatch(setLassoDrawing(value))} />
            </label>
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: 11 }}>
                {drawing
                    ? "arraste sobre o volume pra desenhar — a órbita está congelada"
                    : "ligue pra desenhar; desligado, o mouse volta a orbitar"}
            </div>

            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {OPS.map((entry) => (
                    <label key={entry.value} style={{ display: "flex", alignItems: "center", gap: 6 }} title={entry.hint}>
                        <input
                            type="radio"
                            name="lasso-op"
                            checked={op === entry.value}
                            onChange={() => dispatch(setLassoOp(entry.value))}
                        />
                        <span>{entry.label}</span>
                    </label>
                ))}
            </div>

            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
                <span>ativos</span>
                <span>{cursor} de {total}</span>
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <Button size="sm" variant="secondary" disabled={cursor === 0} onClick={() => dispatch(undoLasso())}>
                    desfazer
                </Button>
                <Button size="sm" variant="secondary" disabled={cursor >= total} onClick={() => dispatch(redoLasso())}>
                    refazer
                </Button>
                <Button size="sm" variant="ghost" disabled={total === 0} onClick={() => dispatch(clearLassos())}>
                    limpar
                </Button>
            </div>
            <div style={{ marginTop: 6, opacity: 0.6, fontSize: 11 }}>
                ctrl+z / ctrl+shift+z
            </div>
        </FloatingPanel>
    );
}
