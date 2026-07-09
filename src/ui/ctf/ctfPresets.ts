//Curvas de CTF padrão pro editor. Cada preset é uma tabela de CtfPoint (HU
//crescente, alpha 0 na ponta baixa — CTF bem-formada, o clamp estende
//transparente pra baixo). Calibradas pra HU de CT. Selecionar um no editor só
//despacha setCtfPoints(points) — não mexe no domínio do eixo (esse é do exame).
import type { CtfPoint } from "../../ctf";

export interface CtfPreset {
    name: string;
    points: CtfPoint[];
}

export const CTF_PRESETS: CtfPreset[] = [
    {
        //a curva inicial do app: abdômen em fase venosa com contraste
        name: "Abdômen (venoso)",
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
        name: "Osso",
        points: [
            { hu: 100, r: 0.90, g: 0.85, b: 0.72, a: 0.0 },
            { hu: 300, r: 0.93, g: 0.88, b: 0.76, a: 0.12 },
            { hu: 550, r: 1.0, g: 0.96, b: 0.85, a: 0.5 },
            { hu: 1200, r: 1.0, g: 1.0, b: 0.95, a: 0.95 },
        ],
    },
    {
        //angio: realce de contraste (vasos) vermelho→laranja, osso fecha marfim
        name: "Angio (vasos)",
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
        name: "Tecido mole",
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
        name: "Pulmão",
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
        name: "Pele (superfície)",
        points: [
            { hu: -320, r: 0.85, g: 0.66, b: 0.56, a: 0.0 },
            { hu: -180, r: 0.90, g: 0.70, b: 0.60, a: 0.55 },
            { hu: -60, r: 0.90, g: 0.72, b: 0.62, a: 0.85 },
            { hu: 120, r: 0.88, g: 0.74, b: 0.64, a: 0.9 },
        ],
    },
    {
        //grayscale: rampa cinza translúcida do ar ao osso — tudo visível
        name: "Grayscale (tudo)",
        points: [
            { hu: -1000, r: 0.05, g: 0.05, b: 0.05, a: 0.0 },
            { hu: -500, r: 0.30, g: 0.30, b: 0.30, a: 0.08 },
            { hu: 0, r: 0.50, g: 0.50, b: 0.50, a: 0.16 },
            { hu: 500, r: 0.78, g: 0.78, b: 0.78, a: 0.42 },
            { hu: 1200, r: 1.0, g: 1.0, b: 1.0, a: 0.85 },
        ],
    },
];
