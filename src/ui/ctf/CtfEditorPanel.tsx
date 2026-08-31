//Editor da Color Transfer Function: painel flutuante com um gráfico dos pontos
//de controle. X = HU (domínio = faixa do exame, vinda do metadata via redux),
//Y = opacidade; a cor (RGB) de cada ponto pinta uma rampa (linearGradient) sob
//a curva de alpha + a colorbar de referência embaixo.
//
//Interações (idioma de setPointerCapture, igual a FloatingPanel/OrbitControls):
//  - arrastar um ponto (clamp em HU entre os vizinhos → a ordem nunca muda,
//    então o índice selecionado sobrevive ao drag);
//  - clicar no vazio cria um ponto (cor interpolada da curva ali);
//  - selecionar um ponto e editar RGB (react-colorful) / deletar (botão).
//
//É PURA UI: lê state.ctf e despacha setCtfPoints — que o reducer reordena por
//HU e que já dispara o recálculo do skip-map na VolumeRaycastESSBehaviour (e a
//SetCtfBehaviour do CT). Zero mudança de engine. Como a CTF é da MODALIDADE, o
//painel serve a qualquer mundo de volume.
import { useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { useDispatch, useSelector } from "react-redux";
import { RgbColorPicker } from "react-colorful";
import { setCtfPoints } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import type { CtfPoint } from "../../ctf";
import { FloatingPanel } from "../generic/FloatingPanel";
import { CTF_PRESETS, materializePreset } from "./ctfPresets";

//Geometria do SVG (tamanho fixo → coord do SVG == pixel renderizado, então a
//conversão clientX→SVG é só clientX - rect.left, sem escalar).
const W = 300;
const H = 190;
const PAD_X = 12;
const PAD_TOP = 10;
//colorbar + a linha de rótulos do eixo X embaixo dela. PLOT_B (= H - PAD_BOT)
//continua em 147, então a área de plot é a mesma de antes.
const PAD_BOT = 43;
const PLOT_L = PAD_X;
const PLOT_R = W - PAD_X;
const PLOT_T = PAD_TOP;
const PLOT_B = H - PAD_BOT;
const BAR_Y = PLOT_B + 8;
const BAR_H = 12;
//linha de texto com os extremos do domínio, logo abaixo da colorbar
const LABEL_Y = BAR_Y + BAR_H + 11;
//1 HU de folga pra um ponto não encostar no vizinho no drag (mantém a ordem)
const HU_EPS = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const rgbCss = (p: { r: number; g: number; b: number }) =>
    `rgb(${Math.round(p.r * 255)}, ${Math.round(p.g * 255)}, ${Math.round(p.b * 255)})`;

//Cor da CTF em `hu` (piecewise-linear, clamp nas pontas) — dá cor a um ponto
//novo criado no meio da curva.
function sampleColor(points: readonly CtfPoint[], hu: number): { r: number; g: number; b: number } {
    if (points.length === 0) return { r: 0.5, g: 0.5, b: 0.5 };
    if (hu <= points[0].hu) return { r: points[0].r, g: points[0].g, b: points[0].b };
    const last = points[points.length - 1];
    if (hu >= last.hu) return { r: last.r, g: last.g, b: last.b };
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i + 1];
        if (hu <= p1.hu) {
            const p0 = points[i];
            const t = (hu - p0.hu) / (p1.hu - p0.hu || 1);
            return {
                r: p0.r + (p1.r - p0.r) * t,
                g: p0.g + (p1.g - p0.g) * t,
                b: p0.b + (p1.b - p0.b) * t,
            };
        }
    }
    return { r: last.r, g: last.g, b: last.b };
}

export function CtfEditorPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const points = useSelector((s: RootState) => s.ctf.points);
    const huMin = useSelector((s: RootState) => s.ctf.huMin);
    const huMax = useSelector((s: RootState) => s.ctf.huMax);
    //Janela do exame — só os presets de MR usam, pra se ancorar (ver ctfPresets).
    const windowCenter = useSelector((s: RootState) => s.ctf.windowCenter);
    const windowWidth = useSelector((s: RootState) => s.ctf.windowWidth);
    const [selected, setSelected] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const dragging = useRef<number | null>(null);

    //DOMÍNIO DO EIXO X. Base é a faixa de valores do exame (metadata), mas
    //UNIDA à faixa dos pontos.
    //
    //Só a faixa do exame não serve: a CTF sobrevive à troca de exame, e uma
    //curva montada em HU de CT (osso em 1000) aberta num MR — cujos valores vão
    //de 0 a 490 — jogava pontos pra fora do SVG. Não desenhavam, não recebiam
    //clique, e nada na tela dizia que existiam: a curva simplesmente aparecia
    //truncada. Unir os dois domínios torna "todo ponto é alcançável" uma
    //invariante do gráfico, seja qual for a origem dos pontos.
    //
    //E é auto-corretivo: criar e arrastar continuam clampados na faixa do
    //EXAME (ver onBackgroundDown/onPointMove), então mexer num ponto perdido o
    //traz pra dentro do dado — quando o último entra, o domínio volta sozinho a
    //ser exatamente o do exame.
    const pointsMin = points.length ? points[0].hu : huMin;
    const pointsMax = points.length ? points[points.length - 1].hu : huMax;
    const domainMin = Math.min(huMin, pointsMin);
    const domainMax = Math.max(huMax, pointsMax);
    const range = Math.max(domainMax - domainMin, 1e-6);
    //true quando há ponto fora do exame — o gráfico marca as zonas mortas.
    const hasOutliers = domainMin < huMin || domainMax > huMax;

    const huToX = (hu: number) => PLOT_L + ((hu - domainMin) / range) * (PLOT_R - PLOT_L);
    const aToY = (a: number) => PLOT_B - a * (PLOT_B - PLOT_T);
    const xToHu = (x: number) => domainMin + ((x - PLOT_L) / (PLOT_R - PLOT_L)) * range;
    const yToA = (y: number) => (PLOT_B - y) / (PLOT_B - PLOT_T);

    const svgCoords = (e: ReactPointerEvent) => {
        const rect = svgRef.current!.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const commit = (next: CtfPoint[]) => dispatch(setCtfPoints(next));

    //clique no vazio → cria ponto (α do y do clique, cor interpolada da curva)
    const onBackgroundDown = (e: ReactPointerEvent<SVGRectElement>) => {
        const { x, y } = svgCoords(e);
        const hu = clamp(xToHu(x), huMin, huMax);
        const a = clamp(yToA(y), 0, 1);
        const np: CtfPoint = { hu, a, ...sampleColor(points, hu) };
        //índice ordenado do novo ponto (pra selecioná-lo depois do sort do reducer)
        const idx = points.filter((p) => p.hu < hu).length;
        commit([...points, np]);
        setSelected(idx);
    };

    const onPointDown = (i: number) => (e: ReactPointerEvent<SVGCircleElement>) => {
        e.stopPropagation(); //não cria ponto por baixo
        setSelected(i);
        dragging.current = i;
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointMove = (e: ReactPointerEvent<SVGCircleElement>) => {
        const i = dragging.current;
        if (i === null) return;
        const { x, y } = svgCoords(e);
        //clamp em HU entre os vizinhos (mantém a ordem → índice estável)
        const lo = i > 0 ? points[i - 1].hu + HU_EPS : huMin;
        const hi = i < points.length - 1 ? points[i + 1].hu - HU_EPS : huMax;
        const hu = clamp(xToHu(x), Math.min(lo, hi), Math.max(lo, hi));
        const a = clamp(yToA(y), 0, 1);
        commit(points.map((p, j) => (j === i ? { ...p, hu, a } : p)));
    };
    const onPointUp = (e: ReactPointerEvent<SVGCircleElement>) => {
        dragging.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    const updateColor = (c: { r: number; g: number; b: number }) => {
        if (selected === null) return;
        commit(points.map((p, j) =>
            j === selected ? { ...p, r: c.r / 255, g: c.g / 255, b: c.b / 255 } : p));
    };
    const deleteSelected = () => {
        if (selected === null || points.length <= 2) return; //mantém ≥2 pra rampa válida
        commit(points.filter((_, j) => j !== selected));
        setSelected(null);
    };

    //troca a CTF inteira por um preset. materializePreset devolve cópias novas
    //(o preset é const compartilhada) e resolve os de MR contra a janela DESTE
    //exame — os de CT saem em HU, inalterados. O select é uma AÇÃO: volta pro
    //placeholder depois (value controlado em "") pra dar pra reaplicar o mesmo.
    const applyPreset = (e: ChangeEvent<HTMLSelectElement>) => {
        const idx = Number(e.currentTarget.value);
        if (!Number.isInteger(idx) || idx < 0 || idx >= CTF_PRESETS.length) return;
        commit(materializePreset(CTF_PRESETS[idx], { windowCenter, windowWidth, huMin, huMax }));
        setSelected(null);
    };

    const sel = selected !== null ? points[selected] : null;
    const areaPath = points.length
        ? `M ${huToX(points[0].hu)} ${PLOT_B} ` +
          points.map((p) => `L ${huToX(p.hu)} ${aToY(p.a)}`).join(" ") +
          ` L ${huToX(points[points.length - 1].hu)} ${PLOT_B} Z`
        : "";
    const linePts = points.map((p) => `${huToX(p.hu)},${aToY(p.a)}`).join(" ");

    return (
        <FloatingPanel title="CTF" width={W + 24} height="auto" style={{ top: 8, left: 300 }}>
            {/*curvas padrão: aplicar troca a CTF inteira (dispara o rebake +
               recálculo do skip-map). value="" = age como botão e reseta.*/}
            <select value="" onChange={applyPreset} style={{ width: "100%", marginBottom: 8 }}>
                <option value="" disabled>
                    curvas padrão…
                </option>
                {/*agrupado por domínio: os de CT são HU absoluto, os de MR se
                   ancoram na janela do exame. Com 11 na lista, sem os grupos
                   fica fácil aplicar um de CT num MR sem perceber.*/}
                <optgroup label="CT — Hounsfield absoluto">
                    {CTF_PRESETS.map((preset, i) =>
                        preset.domain === "hu" ? (
                            <option key={i} value={i}>{preset.name}</option>
                        ) : null)}
                </optgroup>
                <optgroup label="MR — ancorado na janela do exame">
                    {CTF_PRESETS.map((preset, i) =>
                        preset.domain === "window" ? (
                            <option key={i} value={i}>{preset.name}</option>
                        ) : null)}
                </optgroup>
            </select>
            <svg
                ref={svgRef}
                width={W}
                height={H}
                style={{ touchAction: "none", display: "block", background: "#111", borderRadius: 4 }}
            >
                <defs>
                    <linearGradient id="ctfRamp" x1="0" y1="0" x2="1" y2="0">
                        {points.map((p, i) => (
                            <stop
                                key={i}
                                offset={`${clamp((p.hu - domainMin) / range, 0, 1) * 100}%`}
                                stopColor={rgbCss(p)}
                            />
                        ))}
                    </linearGradient>
                </defs>
                {/*ZONAS MORTAS: o pedaço do domínio que está FORA da faixa de
                   valores do exame. Largura zero quando não há ponto fora (o
                   caso normal), então some sozinho. Sem isto o gráfico mentiria:
                   um ponto em 1000 num exame que vai só até 490 apareceria como
                   se houvesse dado ali. pointerEvents=none pra continuar dando
                   pra clicar/criar por cima.*/}
                {hasOutliers && (
                    <>
                        <rect
                            x={PLOT_L}
                            y={PLOT_T}
                            width={Math.max(0, huToX(huMin) - PLOT_L)}
                            height={PLOT_B - PLOT_T}
                            fill="#000"
                            fillOpacity={0.45}
                            pointerEvents="none"
                        />
                        <rect
                            x={huToX(huMax)}
                            y={PLOT_T}
                            width={Math.max(0, PLOT_R - huToX(huMax))}
                            height={PLOT_B - PLOT_T}
                            fill="#000"
                            fillOpacity={0.45}
                            pointerEvents="none"
                        />
                    </>
                )}
                {/*alvo de clique pra CRIAR ponto — sob os pontos, que dão stopPropagation*/}
                <rect
                    x={PLOT_L}
                    y={PLOT_T}
                    width={PLOT_R - PLOT_L}
                    height={PLOT_B - PLOT_T}
                    fill="transparent"
                    style={{ cursor: "crosshair" }}
                    onPointerDown={onBackgroundDown}
                />
                {/*área sob a curva de alpha, colorida pela rampa da CTF*/}
                {areaPath && <path d={areaPath} fill="url(#ctfRamp)" fillOpacity={0.8} pointerEvents="none" />}
                {/*linha de alpha*/}
                {points.length > 1 && (
                    <polyline points={linePts} fill="none" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />
                )}
                {/*colorbar de referência (cor em opacidade cheia)*/}
                <rect
                    x={PLOT_L}
                    y={BAR_Y}
                    width={PLOT_R - PLOT_L}
                    height={BAR_H}
                    fill="url(#ctfRamp)"
                    stroke="#333"
                    pointerEvents="none"
                />
                {/*extremos do domínio desenhado. Sem eles não dá pra saber em que
                   escala o gráfico está — foi parte do que escondeu o bug.*/}
                <text x={PLOT_L} y={LABEL_Y} fontSize={9} fill="#888" pointerEvents="none">
                    {Math.round(domainMin)}
                </text>
                <text
                    x={PLOT_R}
                    y={LABEL_Y}
                    fontSize={9}
                    fill="#888"
                    textAnchor="end"
                    pointerEvents="none"
                >
                    {Math.round(domainMax)}
                </text>
                {/*com ponto fora, marca também onde o exame termina*/}
                {hasOutliers && (
                    <text
                        x={clamp((huToX(huMin) + huToX(huMax)) / 2, PLOT_L + 30, PLOT_R - 30)}
                        y={LABEL_Y}
                        fontSize={9}
                        fill="#bbb"
                        textAnchor="middle"
                        pointerEvents="none"
                    >
                        exame {Math.round(huMin)}…{Math.round(huMax)}
                    </text>
                )}
                {/*os pontos de controle (fill = a cor deles)*/}
                {points.map((p, i) => (
                    <circle
                        key={i}
                        cx={huToX(p.hu)}
                        cy={aToY(p.a)}
                        r={selected === i ? 6 : 4.5}
                        fill={rgbCss(p)}
                        stroke={selected === i ? "#fff" : "#000"}
                        strokeWidth={selected === i ? 2 : 1}
                        style={{ cursor: "grab" }}
                        onPointerDown={onPointDown(i)}
                        onPointerMove={onPointMove}
                        onPointerUp={onPointUp}
                    />
                ))}
            </svg>

            {sel ? (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                        <span>HU {Math.round(sel.hu)} · α {sel.a.toFixed(2)}</span>
                        <button onClick={deleteSelected} disabled={points.length <= 2}>
                            deletar ponto
                        </button>
                    </div>
                    <RgbColorPicker
                        color={{
                            r: Math.round(sel.r * 255),
                            g: Math.round(sel.g * 255),
                            b: Math.round(sel.b * 255),
                        }}
                        onChange={updateColor}
                    />
                </div>
            ) : (
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>
                    {hasOutliers
                        ? "há pontos fora da faixa do exame (área escura) — arraste-os pra dentro"
                        : "clique num ponto pra editar · clique no vazio pra criar"}
                </div>
            )}
        </FloatingPanel>
    );
}
