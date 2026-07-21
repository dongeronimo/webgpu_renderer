//Medidor de tempo de GPU por frame via timestamp queries — o ÚNICO tempo
//que importa pra comparar técnicas: quanto a command list demorou NA GPU.
//FPS de CPU (requestAnimationFrame) mede outra coisa (e satura no vsync).
//
//Como funciona: cada render pass pede seus timestampWrites ao começar
//(timestamp no início e no fim do pass — o WebGPU só permite medir em
//fronteira de pass, não há mais writeTimestamp avulso no encoder). No fim
//do frame o main manda resolver as queries num buffer e copiá-lo pra um
//staging mapeável; a leitura é assíncrona (mapAsync), então o valor
//exibido tem alguns frames de atraso — irrelevante pra um contador.
//Ring de stagings pra nunca esperar a GPU: se todos estiverem ocupados,
//o frame simplesmente não é medido.
//
//Singleton no molde do store/registries: os passes importam e pedem
//timestampWrites sem conhecer o main; o main faz begin/end/readback.
//Precisa da feature "timestamp-query" (gpu.ts pede se o adapter tiver);
//sem ela, tudo aqui vira no-op e o snapshot diz supported: false.
//
//Nota Chrome: sem a flag "WebGPU Developer Features" os timestamps vêm
//quantizados (~100µs) por proteção contra fingerprinting — ruído pequeno
//na escala de ms que interessa aqui.

//passes medidos por frame (2 timestamps cada). Generoso de propósito: o
//GauntletShadowPass mede 1 por LUZ visível (spot/directional), não 1 só
//agregado — a tabela cresce com o Nº de luzes, que é exatamente o custo que
//se quer enxergar. Custo do slot extra é irrisório (16 bytes/query).
const MAX_PASSES = 64;
const STAGING_COUNT = 4; //frames de leitura em voo antes de pular medição
const EMA_ALPHA = 0.1; //suavização exponencial dos valores exibidos

export interface GpuPassStat {
    label: string;
    ms: number;
}

/** Snapshot pro consumo da UI (usePolled) — objeto novo a cada chamada. */
export interface GpuStatsSnapshot {
    supported: boolean;
    /** Frames por segundo do loop de CPU (suavizado). */
    fps: number;
    /** Tempo de GPU do frame: soma dos passes medidos, em ms (suavizado). */
    gpuMs: number;
    /** Tempo por pass, na ordem em que rodaram (suavizado por label). */
    passes: GpuPassStat[];
}

class GpuTimer {
    private supported = false;

    private querySet: GPUQuerySet | null = null;
    private resolveBuffer: GPUBuffer | null = null;
    private stagings: { buffer: GPUBuffer; busy: boolean }[] = [];

    //estado do frame corrente
    private passCount = 0;
    private frameLabels: string[] = [];
    private pending: { staging: { buffer: GPUBuffer; busy: boolean }; labels: string[] } | null = null;

    //fps de CPU
    private lastFrameStart = 0;
    private fpsEma = 0;

    //resultados suavizados
    private gpuMsEma = NaN;
    private readonly passEma = new Map<string, number>();
    private lastPassOrder: string[] = [];

    /** Chamar uma vez no boot, depois do requestDevice. */
    init(device: GPUDevice): void {
        this.supported = device.features.has("timestamp-query");
        if (!this.supported) {
            console.warn("gpuTimer: device sem timestamp-query — tempos de GPU indisponíveis.");
            return;
        }
        this.querySet = device.createQuerySet({
            label: "gpu timer",
            type: "timestamp",
            count: MAX_PASSES * 2,
        });
        this.resolveBuffer = device.createBuffer({
            label: "gpu timer resolve",
            size: MAX_PASSES * 2 * 8, //u64 por timestamp
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        for (let i = 0; i < STAGING_COUNT; i++) {
            this.stagings.push({
                buffer: device.createBuffer({
                    label: `gpu timer staging ${i}`,
                    size: MAX_PASSES * 2 * 8,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                }),
                busy: false,
            });
        }
    }

    /** Início do frame (main, antes do update): zera os slots e conta o fps. */
    beginFrame(): void {
        this.passCount = 0;
        this.frameLabels = [];

        const now = performance.now();
        if (this.lastFrameStart > 0) {
            const dt = now - this.lastFrameStart;
            //ignora pausas (troca de mundo, aba em background) pra não
            //poluir a média com um dt de segundos
            if (dt < 500) {
                const fps = 1000 / dt;
                this.fpsEma = this.fpsEma === 0 ? fps : this.fpsEma + EMA_ALPHA * (fps - this.fpsEma);
            }
        }
        this.lastFrameStart = now;
    }

    /**
     * O pass chama ao montar seu descriptor:
     * `timestampWrites: gpuTimer.timestampWrites("slices")`.
     * undefined (= campo ausente) quando não suportado ou sem slot livre.
     */
    timestampWrites(label: string): GPURenderPassTimestampWrites | undefined {
        if (!this.supported || this.passCount >= MAX_PASSES) {
            return undefined;
        }
        const slot = this.passCount++;
        this.frameLabels.push(label);
        return {
            querySet: this.querySet!,
            beginningOfPassWriteIndex: slot * 2,
            endOfPassWriteIndex: slot * 2 + 1,
        };
    }

    /**
     * Fim do frame (main, DEPOIS do world.render e ANTES do finish):
     * resolve as queries e agenda a cópia pro staging livre.
     */
    endFrame(encoder: GPUCommandEncoder): void {
        this.pending = null;
        if (!this.supported || this.passCount === 0) {
            return;
        }
        const staging = this.stagings.find((s) => !s.busy);
        if (!staging) {
            return; //todas as leituras em voo — este frame fica sem medir
        }
        const bytes = this.passCount * 2 * 8;
        encoder.resolveQuerySet(this.querySet!, 0, this.passCount * 2, this.resolveBuffer!, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer!, 0, staging.buffer, 0, bytes);
        staging.busy = true;
        this.pending = { staging, labels: [...this.frameLabels] };
    }

    /** Depois do submit: dispara a leitura assíncrona do frame recém-medido. */
    readback(): void {
        if (!this.pending) {
            return;
        }
        const { staging, labels } = this.pending;
        this.pending = null;
        const bytes = labels.length * 2 * 8;
        staging.buffer
            .mapAsync(GPUMapMode.READ, 0, bytes)
            .then(() => {
                const ts = new BigUint64Array(staging.buffer.getMappedRange(0, bytes));
                let totalMs = 0;
                for (let i = 0; i < labels.length; i++) {
                    //u64 em nanossegundos; delta negativo (reset de clock da
                    //GPU) é descartado
                    const delta = Number(ts[i * 2 + 1] - ts[i * 2]) / 1e6;
                    const ms = delta >= 0 ? delta : 0;
                    totalMs += ms;
                    const prev = this.passEma.get(labels[i]);
                    this.passEma.set(
                        labels[i],
                        prev === undefined ? ms : prev + EMA_ALPHA * (ms - prev),
                    );
                }
                this.gpuMsEma = Number.isNaN(this.gpuMsEma)
                    ? totalMs
                    : this.gpuMsEma + EMA_ALPHA * (totalMs - this.gpuMsEma);
                this.lastPassOrder = labels;
                staging.buffer.unmap();
                staging.busy = false;
            })
            .catch(() => {
                //destroy() do device no meio de um map — só solta o staging
                staging.busy = false;
            });
    }

    /** Snapshot pra UI — sempre um objeto novo (contrato do usePolled). */
    snapshot(): GpuStatsSnapshot {
        return {
            supported: this.supported,
            fps: this.fpsEma,
            gpuMs: this.gpuMsEma,
            passes: this.lastPassOrder.map((label) => ({
                label,
                ms: this.passEma.get(label) ?? 0,
            })),
        };
    }
}

export const gpuTimer = new GpuTimer();
