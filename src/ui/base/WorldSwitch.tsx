import { useDispatch, useSelector } from "react-redux";
import { switchWorld, type WorldName } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { Button } from "../generic/Button";
import { FloatingPanel } from "../generic/FloatingPanel";
import { worldLabels } from "./WorldLabels";
import { isWorldVisible } from "../../appConfig";



/**
 * contém os botões pra escolha de mundo.
 * @returns
 */
export function WorldSwitch() {
    const dispatch = useDispatch<AppDispatch>();
    const currentWorld = useSelector((state: RootState) => state.base.currentWorld);
    return (
        <FloatingPanel
            title="World Switch"
            width={280}
            height={320}
            style={{ top: 8, right: 8 }}
        >
            {/*style aqui é só layout (empilhar com respiro) — aparência
               continua toda nos módulos css dos genéricos*/}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(Object.keys(worldLabels) as WorldName[]).filter(isWorldVisible).map((world) => (
                    <Button
                        key={world}
                        //primary marca o mundo ativo; clicar nele de novo é
                        //no-op (o lastSeen do main vê o mesmo valor)
                        variant={world === currentWorld ? "primary" : "secondary"}
                        onClick={() => dispatch(switchWorld(world))}
                    >
                        {worldLabels[world]}
                    </Button>
                ))}
            </div>
        </FloatingPanel>
    );
}
