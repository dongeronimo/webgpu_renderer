//Controles do renderer do mundo Raycaster. Por ora só o shading por
//gradiente, no mesmo molde do Render (CT): cada controle despacha uma action;
//a behaviour-cérebro (VolumeRaycastBehaviour) vai ler no update() — nesta
//etapa ninguém consome ainda, é só UI + plumbing do redux.
import { useDispatch, useSelector } from "react-redux";
import { setAlphaScale, SetDebugViewActive, setRaycastEssDebugView, setRaycastFramebufferScale, setRaycastGradientMode, setRaycastGradientShading, type GradientMode } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { FloatingPanel } from "../generic/FloatingPanel";
import { Toggle } from "../generic/Toggle";
import { Slider } from "../generic/Slider";

//As opções do rádio numa lista, pra não repetir o <label>/<input> na mão —
//label é o texto na tela, value é o GradientMode que vai pro redux.
const GRADIENT_MODES: { value: GradientMode; label: string }[] = [
    { value: "precalculated", label: "pré-calculado" },
    { value: "on-the-fly", label: "on-the-fly" },
];

export default function RaycastESSRenderProperties() {
    const dispatch = useDispatch<AppDispatch>();
    const gradientEnabled = useSelector((state: RootState) => state.raycast.gradientEnabled);
    const gradientMode = useSelector((state: RootState) => state.raycast.gradientMode);
    const scaleFactor = useSelector((state:RootState) => state.raycast.framebufferScale);
    const alphaScale = useSelector((state: RootState) => state.textureBasedCT.alphaScale);
    const debugView = useSelector((state: RootState) => state.raycast.essDebugView);
    return (
        <FloatingPanel title="Render (Raycaster)" width={260} height="auto" style={{ top: 8, left: 8 }}>
            {/*label próprio (flex row): texto à esquerda, interruptor à direita —
               clicar no texto alterna o toggle (mesmo molde do painel CT)*/}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>gradiente</span>
                <Toggle
                    checked={gradientEnabled}
                    onChange={(value) => dispatch(setRaycastGradientShading(value))}
                />
            </label>
            {/*div de config: só existe com o gradiente ligado. Renderização
               condicional (e não display:none) — desligado, nem entra no DOM.*/}
            {gradientEnabled && (
                <div style={{ marginTop: 8, paddingLeft: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {GRADIENT_MODES.map((mode) => (
                        //name compartilhado = grupo de rádio (só um marcado por vez).
                        //checked controlado pelo redux; onChange despacha o modo novo.
                        <label key={mode.value} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                                type="radio"
                                name="raycast-gradient-mode"
                                checked={gradientMode === mode.value}
                                onChange={() => dispatch(setRaycastGradientMode(mode.value))}
                            />
                            <span>{mode.label}</span>
                        </label>
                    ))}
                </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span>Framebuffer Scale</span>
                <span>{scaleFactor}</span>
            </div>
            <Slider
                min={0.25}
                max={1}
                value={scaleFactor}
                step={0.05}
                onChange={(value) => dispatch(setRaycastFramebufferScale(value))}
                />
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span>Alpha Scale</span>
                    <span>{alphaScale}</span>
                </div>
                <Slider
                    min={0.1}
                    max={1.0}
                    step={0.1}
                    value={alphaScale}
                    onChange={(value)=>dispatch(setAlphaScale(value))}
                /> 
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Debug view</span>
                <Toggle
                    checked={debugView}
                    onChange={(value) => dispatch(setRaycastEssDebugView(value))}
                />
            </label>               
        </FloatingPanel>
    );
}
