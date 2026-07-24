// Simulador de latência de rede pro loop de dev LOCAL.
//
// Por que: os sintomas de netcode (predição deslizando, snap tremendo) só
// aparecem com latência. Localhost tem ~0ms, então localmente nunca dá pra
// ver/consertar. Este módulo injeta o atraso da nuvem SEM depender de subir
// pra produção (minificado, logs chatos, ciclo lento).
//
// O transporte é WebSocket (TCP): entrega e ordem são garantidas, então perda
// e reordenação de pacote NÃO acontecem de verdade. O que a nuvem causa é
// atraso + jitter — é só isso que simulamos (fielmente). Nada de fake packet
// loss.
//
// Uso: abra o app com  ?lag=120  (RTT alvo em ms) e opcional  &jitter=30.
//   http://localhost:5174/?lag=120&jitter=30
// Ajuste ao vivo no console do browser (sem reload):
//   netSim.down.latency = 200
//   netSim.enabled = false
//
// Sem o param 'lag', enabled=false e schedule() roda na hora (idêntico a hoje).

type Dir = { latency: number; jitter: number };

class NetSim {
    enabled = false;
    up: Dir = { latency: 0, jitter: 0 };    // client -> server (input)
    down: Dir = { latency: 0, jitter: 0 };  // server -> client (state/snap)
    // Última hora de liberação por direção, pra manter ORDEM: uma mensagem
    // nunca sai antes da anterior, mesmo com o jitter sorteando um atraso menor.
    private lastRelease: Record<"up" | "down", number> = { up: 0, down: 0 };

    constructor() {
        const q = new URLSearchParams(location.search);
        if (q.has("lag")) {
            const rtt = Number(q.get("lag")) || 0;      // round-trip alvo
            const jitter = Number(q.get("jitter")) || 0;
            this.enabled = rtt > 0;
            // metade do RTT em cada perna (ida e volta)
            this.up = { latency: rtt / 2, jitter: jitter / 2 };
            this.down = { latency: rtt / 2, jitter: jitter / 2 };
        }
    }

    // Roda fn agora (se desligado) ou depois do atraso da direção, preservando
    // a ordem de chegada dentro daquela direção.
    schedule(dir: "up" | "down", fn: () => void): void {
        if (!this.enabled) { fn(); return; }
        const cfg = this[dir];
        const now = performance.now();
        const delay = cfg.latency + Math.random() * cfg.jitter;
        const releaseAt = Math.max(now + delay, this.lastRelease[dir]);
        this.lastRelease[dir] = releaseAt;
        setTimeout(fn, releaseAt - now);
    }
}

export const netSim = new NetSim();
// exposto pra tunar ao vivo no console (window.netSim.down.latency = ...)
(window as unknown as { netSim: NetSim }).netSim = netSim;
