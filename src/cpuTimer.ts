//Medidor de tempo de CPU por frame — o irmão do gpuTimer.ts. Ele responde
//"quanto a command list demorou NA GPU"; este responde "quanto o JS demorou
//antes de submeter". São custos que crescem por motivos DIFERENTES: o de GPU
//com pixels e overdraw, o de CPU com o número de NODES (a árvore é percorrida
//inteira todo frame, cada nó chamando behaviours e refazendo worldMatrix).
//Com instancing o lado GPU some e o percurso vira o teto do frame — é
//exatamente esse teto que este arquivo torna visível.
//
//Bem mais simples que o gpuTimer porque medir CPU é síncrono: performance.now()
//nas duas pontas, sem query set, sem staging, sem readback assíncrono. O que
//sobra em comum é o idioma — singleton, EMA na mesma alpha, snapshot() novo a
//cada chamada (contrato do usePolled).
//
//Os spans ANINHAM: quem começa dentro de outro aparece indentado na UI, e a
//profundidade sai da própria pilha (nada de passar depth na mão).

const EMA_ALPHA = 0.1; //mesma suavização do gpuTimer

export interface CpuSpanStat {
    label: string;
    ms: number;
    /** 0 = span de topo; a UI indenta por isto. */
    depth: number;
}

/** Snapshot pro consumo da UI (usePolled) — objeto novo a cada chamada. */
export interface CpuStatsSnapshot {
    /** Spans na ordem em que apareceram pela 1ª vez, já suavizados. */
    spans: CpuSpanStat[];
    /** Nós visitados no último percurso — o número que explica o custo acima. */
    nodes: number;
    /** Destes, quantos têm lateUpdate (são revisitados na 2ª passada). */
    lateNodes: number;
}

class CpuTimer {
    //spans abertos, do mais externo pro mais interno
    private readonly stack: { label: string; startedAt: number }[] = [];
    //resultados suavizados e a ordem/profundidade de exibição, fixadas na
    //primeira aparição de cada label (o conjunto de labels de CPU é estático,
    //ao contrário dos passes de GPU, que variam com o Nº de luzes)
    private readonly ms = new Map<string, number>();
    private readonly depth = new Map<string, number>();
    private readonly order: string[] = [];

    private nodes = 0;
    private lateNodes = 0;

    /** Início do frame (main). Só existe pra soltar spans que ficaram abertos
     *  — um throw no meio do update pula o end() e deixaria a pilha suja, e aí
     *  a profundidade de TODOS os frames seguintes sairia errada. */
    beginFrame(): void {
        this.stack.length = 0;
    }

    begin(label: string): void {
        if (!this.depth.has(label)) {
            this.depth.set(label, this.stack.length);
            this.order.push(label);
        }
        this.stack.push({ label, startedAt: performance.now() });
    }

    end(label: string): void {
        const top = this.stack.pop();
        if (top === undefined || top.label !== label) {
            //begin/end desbalanceado (span esquecido aberto, ou end de quem
            //nunca começou): perder a medição é melhor que exibir um número
            //inventado. Solta a pilha pro frame seguinte voltar ao normal.
            this.stack.length = 0;
            return;
        }
        const elapsed = performance.now() - top.startedAt;
        const prev = this.ms.get(label);
        this.ms.set(label, prev === undefined ? elapsed : prev + EMA_ALPHA * (elapsed - prev));
    }

    /** Chamado pelo World no fim do percurso. Não é medição, é o DENOMINADOR:
     *  "3ms de update" só quer dizer alguma coisa junto de "com quantos nós". */
    setTreeCounts(nodes: number, lateNodes: number): void {
        this.nodes = nodes;
        this.lateNodes = lateNodes;
    }

    snapshot(): CpuStatsSnapshot {
        return {
            spans: this.order.map((label) => ({
                label,
                ms: this.ms.get(label) ?? 0,
                depth: this.depth.get(label) ?? 0,
            })),
            nodes: this.nodes,
            lateNodes: this.lateNodes,
        };
    }
}

export const cpuTimer = new CpuTimer();
