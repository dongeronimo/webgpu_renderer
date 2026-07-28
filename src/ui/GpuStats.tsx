//Contador de fps + tempo de GPU + tempo de CPU. Dado por-frame do engine →
//canal de PULL (usePolled lendo os singletons gpuTimer/cpuTimer), nunca redux —
//a regra da fronteira. O snapshot() de cada um devolve objeto novo a cada
//leitura, como o usePolled exige.
//
//Os dois blocos ficam juntos de propósito: a pergunta "por que caiu o fps" só
//se responde comparando os dois. GPU alto = pixels/overdraw; CPU alto = nós
//demais na árvore, e aí o número de nodes ao lado já diz de quem é a culpa.
import { cpuTimer } from "../cpuTimer";
import { gpuTimer } from "../gpuTimer";
import { usePolled } from "./usePolled";

export function GpuStats() {
    const stats = usePolled(() => gpuTimer.snapshot(), 5);
    const cpu = usePolled(() => cpuTimer.snapshot(), 5);

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
            {cpu.spans.length > 0 && (
                <>
                    <div style={{ marginTop: 4 }}>
                        cpu | {cpu.nodes} nodes
                        {cpu.lateNodes > 0 && <span> ({cpu.lateNodes} late)</span>}
                    </div>
                    {cpu.spans.map((s) => (
                        //indentação por profundidade: "update" é o total, os
                        //filhos são as fatias dele
                        <div key={s.label} style={{ opacity: 0.7, paddingLeft: 8 + s.depth * 8 }}>
                            {s.label} {s.ms.toFixed(2)} ms
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}
