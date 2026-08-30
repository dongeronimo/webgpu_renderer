//Captura do traço do LASSO. Camada invisível que cobre o canvas, no lugar do
//OrbitControls (o App monta um OU outro): enquanto o modo lasso está ligado a
//órbita CONGELA, e é essa invariante que deixa a behaviour capturar, no commit,
//a mesma câmera que o usuário tinha na tela quando começou a desenhar.
//
//Aqui mora TODO o input do lasso: acumula o traço em pixels, converte pra NDC,
//simplifica (Douglas-Peucker) e despacha addLasso. A parte 3D não sabe da
//existência do mouse — o canal UI→engine de sempre.
//
//Por que NDC e não pixels: o framebufferScale redimensiona o alvo do main pass,
//e o NDC é imune a isso. E a matriz que a behaviour congela leva o ponto do
//volume direto pra ESTE espaço.
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useDispatch, useSelector } from "react-redux";
import { addLasso } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { LASSO_SIMPLIFY_EPSILON, simplifyPolyline } from "../../raycastLasso/lasso";

//Distância mínima (px) entre pontos gravados: o pointermove dispara muito mais
//denso que o necessário, e o DP no fim ainda vai limpar o resto.
const MIN_POINT_DISTANCE = 3;

export function LassoOverlay() {
    const dispatch = useDispatch<AppDispatch>();
    const op = useSelector((state: RootState) => state.lasso.op);
    //O traço em andamento, em px relativos ao overlay. A REF é a fonte da
    //verdade (o pointerup precisa dos pontos do último move, e não do que o
    //último render viu); o state é só o espelho que faz a SVG redesenhar.
    const strokeRef = useRef<number[]>([]);
    const [stroke, setStroke] = useState<number[]>([]);
    //Retângulo do overlay, congelado no pointerdown: um resize no meio do traço
    //não pode mudar a conversão pra NDC no meio do caminho.
    const rect = useRef<DOMRect | null>(null);
    const pointerId = useRef<number | null>(null);

    function commitStroke(next: number[]) {
        strokeRef.current = next;
        setStroke(next);
    }

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        rect.current = e.currentTarget.getBoundingClientRect();
        pointerId.current = e.pointerId;
        commitStroke([e.clientX - rect.current.left, e.clientY - rect.current.top]);
        //captura: o traço continua mesmo se o ponteiro sair da camada
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        if (pointerId.current !== e.pointerId || !rect.current) {
            return;
        }
        const x = e.clientX - rect.current.left;
        const y = e.clientY - rect.current.top;
        const prev = strokeRef.current;
        if (Math.hypot(x - prev[prev.length - 2], y - prev[prev.length - 1]) < MIN_POINT_DISTANCE) {
            return;
        }
        commitStroke([...prev, x, y]);
    }

    function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
        if (pointerId.current !== e.pointerId) {
            return;
        }
        pointerId.current = null;
        const box = rect.current;
        rect.current = null;
        const drawn = strokeRef.current;
        commitStroke([]);
        if (!box || drawn.length < 6) {
            return; //clique solto ou risco: não vira lasso
        }
        //px do overlay → NDC do WebGPU: x cresce pra direita nos dois, mas y
        //cresce pra BAIXO na tela e pra CIMA no NDC — daí a inversão.
        const ndc: number[] = [];
        for (let i = 0; i < drawn.length; i = i + 2) {
            ndc.push((drawn[i] / box.width) * 2 - 1, 1 - (drawn[i + 1] / box.height) * 2);
        }
        //Simplifica ANTES de guardar: o laço de arestas do shader roda por
        //AMOSTRA de raio, então cada vértice a menos vale muito.
        dispatch(addLasso(simplifyPolyline(ndc, LASSO_SIMPLIFY_EPSILON)));
    }

    function onPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
        if (pointerId.current === e.pointerId) {
            pointerId.current = null;
            rect.current = null;
            commitStroke([]);
        }
    }

    //Traço aberto enquanto desenha + a corda de fechamento pontilhada, pra
    //deixar claro que o polígono fecha sozinho no pointerup.
    const path = [];
    for (let i = 0; i < stroke.length; i = i + 2) {
        path.push(`${stroke[i]},${stroke[i + 1]}`);
    }
    const drawing = path.length > 1;
    const colour = op === "remove-inside" ? "#ff5a5a" : "#5ad2ff";

    return (
        <div
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "auto",
                touchAction: "none",
                cursor: "crosshair",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
        >
            <svg
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            >
                {drawing && (
                    <>
                        <polyline
                            points={path.join(" ")}
                            fill="none"
                            stroke={colour}
                            strokeWidth={2}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                        <line
                            x1={stroke[stroke.length - 2]}
                            y1={stroke[stroke.length - 1]}
                            x2={stroke[0]}
                            y2={stroke[1]}
                            stroke={colour}
                            strokeWidth={1}
                            strokeDasharray="4 4"
                            opacity={0.6}
                        />
                    </>
                )}
            </svg>
        </div>
    );
}
