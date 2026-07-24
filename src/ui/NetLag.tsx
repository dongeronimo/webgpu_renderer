//Medidor de lag (RTT do socket de jogo), irmão do GpuStats: mesmo canal de
//PULL (usePolled lendo o singleton netStats). Só aparece quando há jogo (pong
//chegando); apaga (opacity) quando fica stale.
import { netStats } from "../gauntlet/netStats";
import { usePolled } from "./usePolled";

export function NetLag() {
    const s = usePolled(() => netStats.snapshot(), 4);
    if (s.samples === 0) return null; //ainda não entrou em jogo
    return (
        <div style={{ opacity: s.stale ? 0.4 : 1 }}>
            {s.rttMs.toFixed(0)} ms lag
        </div>
    );
}
