//Controles do renderer do mundo CT. Fluxo UI→engine padrão: o slider
//despacha a intenção pro redux; quem consome é a SetNumSlicesBehaviour
//pendurada no nó-pilha, que repassa pro TextureSliceGenerator.
import { useDispatch, useSelector } from "react-redux";
import { setAlphaScale, SetDebugViewActive, setTextureBasedCTNumSlices } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import type { World } from "../../world";
import { FloatingPanel } from "../generic/FloatingPanel";
import { Slider } from "../generic/Slider";
import { Toggle } from "../generic/Toggle";

//world ainda não é lido (nenhum controle olha o scene graph por enquanto);
//o _ segura o noUnusedParameters até precisarmos
export default function TbCTRenderProperties({ world: _world }: { world: World }) {
    const dispatch = useDispatch<AppDispatch>();
    const numSlices = useSelector((state: RootState) => state.textureBasedCT.numSlices);
    const alphaScale = useSelector((state: RootState) => state.textureBasedCT.alphaScale);
    const debugViewActive = useSelector((state: RootState) => state.textureBasedCT.debugViewActive);
    return (
        <FloatingPanel title="Render (CT)" width={260} height="auto" style={{ top: 8, left: 8 }}>
            {/*label em volta do slider: clicar no texto foca o input*/}
            <label style={{ display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span>fatias</span>
                    <span>{numSlices}</span>
                </div>
                <Slider
                    min={16}
                    max={512}
                    value={numSlices}
                    onChange={(value) => dispatch(setTextureBasedCTNumSlices(value))}
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
            </label>
            {/*label próprio (flex row): texto à esquerda, interruptor à
               direita — clicar no texto alterna o toggle*/}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <span>debug (fatias)</span>
                <Toggle
                    checked={debugViewActive}
                    onChange={(value) => dispatch(SetDebugViewActive(value))}
                />
            </label>
        </FloatingPanel>
    );
}
