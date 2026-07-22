//Painel de config de shadow map do Gauntlet: 1 campo de texto controlando a
//resolução (px, quadrado) dos shadow maps de spot/directional em tempo real.
//Dispatch → redux → GauntletWorld lê no update() (padrão lastSeen) e manda a
//GauntletLighting redimensionar os render targets — ver gauntletWorld.ts.
import { useState } from "react";
import type { ChangeEvent } from "react";
import { useDispatch, useSelector } from "react-redux";
import { setGauntletShadowMapSize } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { SHADOW_MAP_MIN_SIZE, SHADOW_MAP_MAX_SIZE } from "../../gauntlet/gauntletLighting";
import { FloatingPanel } from "../generic/FloatingPanel";

export function GauntletShadowSettingsPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const shadowMapSize = useSelector((state: RootState) => state.gauntlet.shadowMapSize);
    //Texto livre enquanto digita (senão o usuário não consegue apagar pra
    //trocar o número) — só clampa e despacha quando o valor parsear.
    const [text, setText] = useState(String(shadowMapSize));

    function onChange(e: ChangeEvent<HTMLInputElement>) {
        const raw = e.target.value;
        setText(raw);
        const parsed = Number(raw);
        if (raw !== "" && Number.isFinite(parsed)) {
            const clamped = Math.max(SHADOW_MAP_MIN_SIZE, Math.min(SHADOW_MAP_MAX_SIZE, Math.floor(parsed)));
            dispatch(setGauntletShadowMapSize(clamped));
        }
    }

    return (
        <FloatingPanel title="Sombras" width={200} height="auto" style={{ top: 8, right: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label>
                    Shadow map (px)
                    <input
                        type="number"
                        min={SHADOW_MAP_MIN_SIZE}
                        max={SHADOW_MAP_MAX_SIZE}
                        value={text}
                        onChange={onChange}
                    />
                </label>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                    {SHADOW_MAP_MIN_SIZE}–{SHADOW_MAP_MAX_SIZE}. Spot/directional só — point light ainda não tem sombra.
                </div>
            </div>
        </FloatingPanel>
    );
}
