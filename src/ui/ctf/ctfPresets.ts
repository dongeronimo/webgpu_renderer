//Curvas de CTF padrão pro editor. Selecionar uma no editor despacha
//setCtfPoints(points) — não mexe no domínio do eixo (esse é do exame).
//
//DOIS DOMÍNIOS, e é o ponto todo deste arquivo:
//
//  "hu"     — pontos em Hounsfield absolutos. Serve pra CT e só pra CT: HU é
//             escala física calibrada (água 0, ar -1000), então "osso em 1000"
//             quer dizer a mesma coisa em qualquer tomógrafo do mundo.
//
//  "window" — pontos em unidades da JANELA do exame. MR não tem escala
//             absoluta: os valores são unidades arbitrárias do aparelho, e o
//             mesmo crânio sai 0..490 numa série e 0..4000 noutra. Preset em
//             valor absoluto não transfere. O que transfere é a janela de
//             exibição (WindowCenter/WindowWidth) que o próprio aparelho
//             gravou, porque ela é calibrada PELO TECIDO daquela série.
//
//A conversão é t → valor = centro + (t - 0.5) * largura. Então t=0 é a borda
//de baixo da janela, t=0.5 o centro, t=1 a borda de cima, e t>1 extrapola pra
//cima dela — que é exatamente onde vive o vaso num TOF.
//
//POR QUE a janela é a âncora certa, medido no TOF de crânio (window 72.17 /
//125.42, valores 0..490): 42% do volume está em 0..20 (fundo), o parênquima
//ocupa 20..130, e aí cai um penhasco — 130..160 é 0,54% do volume e acima de
//160 sobra 0,2%. Esse 0,2% é o vaso. A borda de baixo da janela (9.5) cai no
//corte do fundo; a de cima (134.9) cai EM CIMA do penhasco. Ou seja: "alpha 0
//até t=1, rampa acima" é a definição de uma angio, escrita numa unidade que
//outro exame de MR também entende.
import type { CtfPoint } from "../../ctf";

/** Ponto de um preset em unidades de janela. Mesmo dado do CtfPoint, com t no
 *  lugar do hu — o campo tem nome diferente pra não dar pra passar um pelo
 *  outro sem materializar. */
export interface CtfWindowPoint {
    /** 0 = borda inferior da janela, 0.5 = centro, 1 = borda superior. Pode
     *  passar de 1: acima da janela é onde fica o sinal de fluxo do TOF. */
    t: number;
    r: number;
    g: number;
    b: number;
    a: number;
}

export type CtfPreset =
    | { name: string; domain: "hu"; points: CtfPoint[] }
    | { name: string; domain: "window"; points: CtfWindowPoint[] };

/** O que o exame carregado sabe sobre a própria escala (vem do state.ctf). */
export interface CtfPresetContext {
    /** WindowCenter do DICOM. Ignorado se windowWidth <= 0. */
    windowCenter: number;
    /** WindowWidth do DICOM; <= 0 quando o exame não trazia a tag. */
    windowWidth: number;
    /** Faixa de valores do volume — o fallback quando não há janela. */
    huMin: number;
    huMax: number;
}

/**
 * Converte um preset nos pontos que vão pro redux.
 *
 * Preset "hu" passa direto (cópia — o preset é const compartilhada). Preset
 * "window" é resolvido contra a janela do exame; sem a tag WindowCenter/Width,
 * o fallback é tratar a faixa INTEIRA de valores como se fosse a janela. O
 * fallback é um chute honesto e não uma correção: sem janela não há nada que
 * diga onde o tecido acaba, então a curva vai cair fora de lugar e o usuário
 * vai ter que arrastar. O editor mostra os pontos de qualquer jeito (o domínio
 * do gráfico une a faixa do exame com a dos pontos), então nada some.
 */
export function materializePreset(preset: CtfPreset, ctx: CtfPresetContext): CtfPoint[] {
    if (preset.domain === "hu") {
        return preset.points.map((p) => ({ ...p }));
    }
    const hasWindow = Number.isFinite(ctx.windowWidth) && ctx.windowWidth > 0
        && Number.isFinite(ctx.windowCenter);
    const width = hasWindow ? ctx.windowWidth : Math.max(ctx.huMax - ctx.huMin, 1e-6);
    const center = hasWindow ? ctx.windowCenter : (ctx.huMin + ctx.huMax) / 2;
    return preset.points.map(({ t, r, g, b, a }) => ({
        hu: center + (t - 0.5) * width,
        r, g, b, a,
    }));
}

export const CTF_PRESETS: CtfPreset[] = [
    // ---------------------------------------------------------------- CT (HU)
    {
        //a curva inicial do app: abdômen em fase venosa com contraste
        name: "CT · Abdômen (venoso)",
        domain: "hu",
        points: [
            { hu: -200, r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            { hu: 80, r: 0.55, g: 0.08, b: 0.06, a: 0.0 },
            { hu: 140, r: 0.80, g: 0.12, b: 0.08, a: 0.18 },
            { hu: 220, r: 1.0, g: 0.45, b: 0.15, a: 0.45 },
            { hu: 400, r: 1.0, g: 0.85, b: 0.55, a: 0.65 },
            { hu: 1000, r: 1.0, g: 0.98, b: 0.92, a: 0.95 },
        ],
    },
    {
        //osso: tecido mole invisível, esponjoso entra ~300 HU, cortical marfim
        name: "CT · Osso",
        domain: "hu",
        points: [
            { hu: 100, r: 0.90, g: 0.85, b: 0.72, a: 0.0 },
            { hu: 300, r: 0.93, g: 0.88, b: 0.76, a: 0.12 },
            { hu: 550, r: 1.0, g: 0.96, b: 0.85, a: 0.5 },
            { hu: 1200, r: 1.0, g: 1.0, b: 0.95, a: 0.95 },
        ],
    },
    {
        //angio: realce de contraste (vasos) vermelho→laranja, osso fecha marfim
        name: "CT · Angio (vasos)",
        domain: "hu",
        points: [
            { hu: 80, r: 0.5, g: 0.06, b: 0.05, a: 0.0 },
            { hu: 200, r: 0.9, g: 0.2, b: 0.12, a: 0.35 },
            { hu: 350, r: 1.0, g: 0.55, b: 0.2, a: 0.7 },
            { hu: 550, r: 1.0, g: 0.85, b: 0.6, a: 0.5 },
            { hu: 1000, r: 1.0, g: 0.98, b: 0.92, a: 0.9 },
        ],
    },
    {
        //tecido mole: gordura/músculo/órgãos avermelhados, osso fraco no fim
        name: "CT · Tecido mole",
        domain: "hu",
        points: [
            { hu: -120, r: 0.7, g: 0.42, b: 0.36, a: 0.0 },
            { hu: 20, r: 0.78, g: 0.46, b: 0.40, a: 0.14 },
            { hu: 70, r: 0.88, g: 0.52, b: 0.45, a: 0.4 },
            { hu: 300, r: 0.95, g: 0.85, b: 0.72, a: 0.5 },
            { hu: 1000, r: 1.0, g: 0.98, b: 0.90, a: 0.7 },
        ],
    },
    {
        //pulmão: parênquima/vias aéreas na faixa de ar-pulmão (-900..-500)
        name: "CT · Pulmão",
        domain: "hu",
        points: [
            { hu: -1000, r: 0.15, g: 0.25, b: 0.45, a: 0.0 },
            { hu: -880, r: 0.35, g: 0.50, b: 0.75, a: 0.12 },
            { hu: -650, r: 0.55, g: 0.72, b: 0.90, a: 0.25 },
            { hu: -450, r: 0.70, g: 0.40, b: 0.40, a: 0.06 },
            { hu: -250, r: 0.70, g: 0.40, b: 0.40, a: 0.0 },
        ],
    },
    {
        //superfície: a transição ar→pele (~-150 HU) vira opaca cor de pele =
        //render de superfície do corpo
        name: "CT · Pele (superfície)",
        domain: "hu",
        points: [
            { hu: -320, r: 0.85, g: 0.66, b: 0.56, a: 0.0 },
            { hu: -180, r: 0.90, g: 0.70, b: 0.60, a: 0.55 },
            { hu: -60, r: 0.90, g: 0.72, b: 0.62, a: 0.85 },
            { hu: 120, r: 0.88, g: 0.74, b: 0.64, a: 0.9 },
        ],
    },
    {
        //grayscale: rampa cinza translúcida do ar ao osso — tudo visível
        name: "CT · Grayscale (tudo)",
        domain: "hu",
        points: [
            { hu: -1000, r: 0.05, g: 0.05, b: 0.05, a: 0.0 },
            { hu: -500, r: 0.30, g: 0.30, b: 0.30, a: 0.08 },
            { hu: 0, r: 0.50, g: 0.50, b: 0.50, a: 0.16 },
            { hu: 500, r: 0.78, g: 0.78, b: 0.78, a: 0.42 },
            { hu: 1200, r: 1.0, g: 1.0, b: 1.0, a: 0.85 },
        ],
    },

    // ------------------------------------------------------ MR (janela do exame)
    {
        //ANGIO TOF pura — a árvore arterial e mais nada. Todo o parênquima fica
        //abaixo de t=1 (a borda de cima da janela), então alpha 0 até lá mata o
        //cérebro inteiro; a rampa vive na cauda de sinal de fluxo. Alpha sobe
        //rápido de propósito: o vaso é fino, o raio atravessa poucos voxels
        //dele, e alpha tímida deixa o ramo distal invisível.
        name: "MR · Angio TOF (vasos)",
        domain: "window",
        points: [
            { t: 0.98, r: 0.45, g: 0.03, b: 0.02, a: 0.00 },
            { t: 1.08, r: 0.85, g: 0.12, b: 0.06, a: 0.35 },
            { t: 1.35, r: 1.00, g: 0.42, b: 0.12, a: 0.70 },
            { t: 1.90, r: 1.00, g: 0.78, b: 0.35, a: 0.92 },
            { t: 3.00, r: 1.00, g: 0.98, b: 0.90, a: 1.00 },
        ],
    },
    {
        //A MESMA árvore, com o cérebro como fantasma cinza pra dar referência
        //anatômica — sem isso a angio flutua no vazio e não dá pra dizer de que
        //lado do crânio está o vaso.
        //
        //As alphas do parênquima parecem absurdas de baixas (0.007-0.010) e não
        //são: essa faixa é ~45% do volume, então o raio cruza CENTENAS de voxels
        //dela e o que é translúcido num ponto vira parede acumulado. Compondo
        //raios reais deste exame com a fórmula do shader
        //(alpha = 1-(1-a*alphaScale)^0.5, alphaScale 0.3): com 0.04/0.06 o raio
        //médio fecha em 0.75 de opacidade e o contraste do vaso contra o fundo
        //cai pra +0.05 — o cérebro engole a angio. Com 0.007/0.010 o raio médio
        //fica em 0.29 e o contraste sobe pra +0.24. Mexer aqui pra cima é
        //desfazer o preset.
        name: "MR · Angio + cérebro",
        domain: "window",
        points: [
            { t: 0.12, r: 0.30, g: 0.32, b: 0.38, a: 0.000 },
            { t: 0.45, r: 0.46, g: 0.48, b: 0.53, a: 0.007 },
            { t: 0.88, r: 0.62, g: 0.64, b: 0.68, a: 0.010 },
            { t: 0.99, r: 0.72, g: 0.34, b: 0.22, a: 0.008 },
            { t: 1.12, r: 0.90, g: 0.16, b: 0.08, a: 0.540 },
            { t: 1.60, r: 1.00, g: 0.55, b: 0.18, a: 0.960 },
            { t: 2.60, r: 1.00, g: 0.92, b: 0.75, a: 1.000 },
        ],
    },
    {
        //Séries anatômicas (T1, T2, FLAIR): sem cauda de fluxo pra realçar, o
        //interesse está DENTRO da janela mesmo. Rampa cinza-marfim cobrindo o
        //miolo dela, opaca no topo — satura como o "Tecido mole" do CT, ou seja
        //mostra a superfície do que for opaco, não um volume translúcido.
        //
        //ÚNICO preset daqui não calibrado contra dado real: só há série TOF
        //exportada. Os outros três foram medidos compondo raios do
        //arterial_tof_sj com a fórmula do shader.
        name: "MR · Cérebro (T1/T2/FLAIR)",
        domain: "window",
        points: [
            { t: 0.08, r: 0.10, g: 0.10, b: 0.12, a: 0.00 },
            { t: 0.30, r: 0.45, g: 0.42, b: 0.40, a: 0.10 },
            { t: 0.60, r: 0.72, g: 0.68, b: 0.64, a: 0.28 },
            { t: 0.90, r: 0.90, g: 0.88, b: 0.84, a: 0.50 },
            { t: 1.20, r: 1.00, g: 0.98, b: 0.95, a: 0.80 },
        ],
    },
    {
        //Superfície: casca opaca na transição fundo→tecido, que em MR fica logo
        //acima da borda de baixo da janela. Equivalente do "Pele" do CT — dá o
        //rosto/couro cabeludo em vez do interior.
        name: "MR · Superfície (pele)",
        domain: "window",
        points: [
            { t: 0.02, r: 0.85, g: 0.68, b: 0.58, a: 0.00 },
            { t: 0.18, r: 0.90, g: 0.72, b: 0.62, a: 0.60 },
            { t: 0.45, r: 0.90, g: 0.74, b: 0.64, a: 0.88 },
            { t: 1.10, r: 0.88, g: 0.74, b: 0.64, a: 0.92 },
        ],
    },
];
