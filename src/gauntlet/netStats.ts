//Medidor de lag (RTT do socket de jogo) — dual do gpuTimer que mede FPS: canal
//de PULL lido por usePolled. GauntletNetwork alimenta com recordRtt() a cada
//pong; a UI (NetLag) lê o snapshot no ritmo que quiser.
class NetStats {
    private ema = 0;
    private samples = 0;
    private lastAt = 0;

    //EMA suave (alpha 0.2): a 1a amostra inicializa direto, as próximas
    //convergem em ~2-3s. Filtra o jitter sem esconder a tendência.
    recordRtt(ms: number): void {
        this.ema = this.samples === 0 ? ms : this.ema + 0.2 * (ms - this.ema);
        this.samples++;
        this.lastAt = performance.now();
    }

    //Objeto novo a cada leitura (usePolled exige snapshot, não referência viva).
    //stale = >2s sem pong (socket caiu / sem jogo) → a UI pode apagar/esconder.
    snapshot(): { rttMs: number; samples: number; stale: boolean } {
        return {
            rttMs: this.ema,
            samples: this.samples,
            stale: this.samples === 0 || performance.now() - this.lastAt > 2000,
        };
    }
}

export const netStats = new NetStats();
