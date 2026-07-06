//Contador de fps + tempo de GPU. Dado por-frame do engine → canal de PULL
//(usePolled lendo o singleton gpuTimer), nunca redux — a regra da fronteira.
//O snapshot() devolve objeto novo a cada leitura, como o usePolled exige.
import { gpuTimer } from "../gpuTimer";
import { usePolled } from "./usePolled";

export function GpuStats() {
    const stats = usePolled(() => gpuTimer.snapshot(), 5);

    return (
        <div style={{ marginBottom: 8 }}>
            <div>
                {stats.fps.toFixed(0)} fps
                {stats.supported && Number.isFinite(stats.gpuMs) && (
                    <span> | gpu {stats.gpuMs.toFixed(2)} ms</span>
                )}
            </div>
            {stats.supported ? (
                stats.passes.map((p) => (
                    <div key={p.label} style={{ opacity: 0.7, paddingLeft: 8 }}>
                        {p.label} {p.ms.toFixed(2)} ms
                    </div>
                ))
            ) : (
                <div style={{ opacity: 0.7 }}>timestamp-query indisponível</div>
            )}
        </div>
    );
}
