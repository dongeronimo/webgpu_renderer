//O LASSO DE REMOÇÃO: o modelo de dados compartilhado pela UI (que desenha),
//pelo redux (que guarda a pilha + o cursor de undo/redo) e pelo material (que
//testa cada amostra do raymarch).
//
//O que É um lasso: um POLÍGONO em NDC mais a CÂMERA CONGELADA do instante do
//desenho. Com câmera perspectiva o sólido de remoção NÃO é um prisma — é uma
//pirâmide infinita com ápice no olho — e é exatamente isso que sai de graça
//guardando a matriz inteira (proj*view*model) em vez de "uma direção": a
//amostra some quando PROJETA dentro do polígono naquela câmera, que é a
//semântica que o usuário viu ao desenhar. Guardar só a direção (prisma, projeção
//ortográfica) casaria com o traço no centro da tela e desalinharia nas bordas.
//
//A matriz NÃO mora aqui nem no redux: quem a captura é a
//VolumeRaycastLassoBehaviour, no frame em que vê um lasso novo (o React não
//conhece o scene graph). Aqui ficam só os vértices, que é o que a UI produz.
//
//NDC e não pixels de propósito: o framebufferScale redimensiona o alvo do main
//pass, e o NDC é imune a isso.

/** O que o lasso faz com o que está DENTRO dele. */
export type LassoOp =
    //corte: o que projeta dentro da pirâmide some (vários = união do removido)
    | "remove-inside"
    //crop: só sobra o que projeta dentro (vários = interseção do mantido)
    | "keep-inside";

export interface LassoRecord {
    /** Único e monotônico (vem do reducer) — é a chave do cache de matrizes. */
    id: number;
    /** Vértices do polígono em NDC, x,y intercalados. Fechamento é implícito. */
    points: number[];
    op: LassoOp;
}

/** Teto de lassos ATIVOS ao mesmo tempo (dimensiona o storage buffer). */
export const MAX_LASSOS = 16;
/** Teto de vértices somando todos os lassos ativos. */
export const MAX_LASSO_VERTICES = 2048;
/** Teto por lasso, aplicado depois da simplificação (rede de segurança). */
export const MAX_VERTICES_PER_LASSO = 192;
/**
 * Tolerância do Douglas-Peucker, em unidades de NDC (a tela tem 2 de largura).
 * ~0.004 = meio ponto percentual da tela: some com o tremor da mão e derruba um
 * traço de centenas de pontos pra algumas dezenas — o laço de arestas do shader
 * roda POR AMOSTRA, então cada vértice a menos vale muito.
 */
export const LASSO_SIMPLIFY_EPSILON = 0.004;

/**
 * Douglas-Peucker num array plano [x0,y0,x1,y1,...]: mantém os vértices cuja
 * remoção afastaria a curva mais que `epsilon` da original. Trata a polilinha
 * ABERTA (do primeiro ao último ponto) — a aresta de fechamento é implícita no
 * shader e não precisa entrar na decisão.
 */
export function simplifyPolyline(pts: readonly number[], epsilon: number): number[] {
    const n = pts.length / 2;
    if (n < 3) {
        return [...pts];
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    //pilha explícita em vez de recursão: um traço longo tem milhares de pontos e
    //a profundidade do DP é O(n) no pior caso.
    const stack: number[][] = [[0, n - 1]];
    while (stack.length > 0) {
        const [i0, i1] = stack.pop()!;
        if (i1 <= i0 + 1) {
            continue;
        }
        const ax = pts[i0 * 2];
        const ay = pts[i0 * 2 + 1];
        const dx = pts[i1 * 2] - ax;
        const dy = pts[i1 * 2 + 1] - ay;
        const len = Math.hypot(dx, dy);
        let worst = -1;
        let worstDist = epsilon;
        for (let i = i0 + 1; i < i1; i = i + 1) {
            const px = pts[i * 2] - ax;
            const py = pts[i * 2 + 1] - ay;
            //distância ponto-reta pela área do paralelogramo; com o segmento
            //degenerado (extremos iguais) vira distância ponto-ponto
            const dist = len > 1e-9 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
            if (dist > worstDist) {
                worstDist = dist;
                worst = i;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push([i0, worst], [worst, i1]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i = i + 1) {
        if (keep[i]) {
            out.push(pts[i * 2], pts[i * 2 + 1]);
        }
    }
    return out;
}

/**
 * AABB do polígono em NDC. Vai pro shader como early-out do teste de
 * ponto-em-polígono: dois compares matam a amostra antes do laço de arestas, e
 * a maioria das amostras de um raio cai fora.
 */
export function polygonBounds(points: readonly number[]): { min: [number, number]; max: [number, number] } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i = i + 2) {
        minX = Math.min(minX, points[i]);
        maxX = Math.max(maxX, points[i]);
        minY = Math.min(minY, points[i + 1]);
        maxY = Math.max(maxY, points[i + 1]);
    }
    return { min: [minX, minY], max: [maxX, maxY] };
}
