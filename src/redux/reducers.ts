//Reducers: funções puras (state, action) => novo state. Redux clássico,
//switch e spread — sem toolkit, sem immer.
import { combineReducers } from "redux";
import type { CtfPoint } from "../ctf";
import { CTF_SET_POINTS, HELLO_CLICKED, SET_ALPHA_SCALE, SET_DEBUG_VIEW_ACTIVE, SWITCH_WORLD, TEXTURE_BASED_CT_SET_NUM_SLICES, type AppAction, type WorldName } from "./actions";

export interface HelloState {
    /** Quantas vezes o botão de hello foi clicado. */
    clickCount: number;
}
/**
 * Estado top-level da app.
 */
export interface BaseState {
    //Qual é o mundo atual?
    currentWorld: WorldName;
}

/**
 * Estado do texture-based ct
 */
export interface TextureBasedCTState {
    //Qual é o numero de slices?
    numSlices:number;
    //Qual é a alpha scale (taxa de acumulo da alpha, controla o quão rápido fica opaco)
    alphaScale: number;
    //A debug view de slices está ativa?
    debugViewActive: boolean;
}

/**
 * Estado da color transfer function. State PRÓPRIO (e não campo do
 * textureBasedCT) de propósito: a CTF é da modalidade, não da técnica —
 * o raycaster, quando existir, consome exatamente esta mesma tabela.
 * Invariante: points sempre ordenado por HU crescente (o reducer garante).
 */
export interface CtfState {
    points: CtfPoint[];
}

const helloInitial: HelloState = {
    clickCount: 0,
};

const baseInitial: BaseState = {
    currentWorld: "textureStackVolumeRenderSynthetic",
};

const textureBasedCTInitial: TextureBasedCTState = {
    numSlices: 128,
    alphaScale: 0.3,
    debugViewActive: true,
}

//CTF inicial calibrada pro exame de public/volumes: abdômen em fase venosa
//com contraste ("LAUDO AB VENOSO"). A narrativa da curva: tudo até tecido
//mole comum é invisível; o realce do contraste (vasos, córtex renal) entra
//em vermelho→laranja; osso fecha em marfim denso. Abaixo do primeiro ponto
//e acima do último vale a cor da ponta (clamp da LUT — ver ctf.ts).
const ctfInitial: CtfState = {
    points: [
        //ar, pulmão, gordura: transparentes (o clamp estende pra baixo)
        { hu: -200, r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        //tecido mole NÃO realçado (~40 HU) ainda invisível — o ramp começa
        //logo acima dele, senão o paciente vira um bloco sólido
        { hu: 80, r: 0.55, g: 0.08, b: 0.06, a: 0.0 },
        //parênquima realçado pelo contraste: vermelho translúcido
        { hu: 140, r: 0.80, g: 0.12, b: 0.08, a: 0.18 },
        //contraste venoso pleno (veias, córtex renal): laranja
        { hu: 220, r: 1.0, g: 0.45, b: 0.15, a: 0.45 },
        //pico do realce / osso esponjoso: amarelo-claro
        { hu: 400, r: 1.0, g: 0.85, b: 0.55, a: 0.65 },
        //osso cortical: marfim, quase opaco
        { hu: 1000, r: 1.0, g: 0.98, b: 0.92, a: 0.95 },
    ],
};

function helloReducer(state: HelloState = helloInitial, action: AppAction): HelloState {
    switch (action.type) {
        case HELLO_CLICKED:
            return { ...state, clickCount: state.clickCount + 1 };
        default:
            return state;
    }
}

//Quem CONSOME currentWorld não pode ser uma behaviour (ela morre junto com
//o mundo que destruiria) — é o main, que vive acima dos mundos, checando o
//valor no loop antes do update (padrão lastSeen).
function baseReducer(state: BaseState = baseInitial, action: AppAction): BaseState {
    switch (action.type) {
        case SWITCH_WORLD:
            return { ...state, currentWorld: action.payload };
        default:
            return state;
    }
}

function textureBasedCTReducer(state:TextureBasedCTState = textureBasedCTInitial,
    action: AppAction) : TextureBasedCTState {
    switch(action.type){
        case TEXTURE_BASED_CT_SET_NUM_SLICES:
            return { ...state, numSlices: action.payload};
        case SET_ALPHA_SCALE:
            return { ...state, alphaScale: action.payload};
        case SET_DEBUG_VIEW_ACTIVE:
            return { ...state, debugViewActive: action.payload};
        default:
            return state;
    }
}

//Ordena AQUI, no único ponto de escrita — quem despacha não precisa saber
//da invariante, e quem consome (SetCtfBehaviour → bakeCtfLut) confia nela.
//Array novo a cada set: é a troca de REFERÊNCIA que a behaviour detecta.
function ctfReducer(state: CtfState = ctfInitial, action: AppAction): CtfState {
    switch (action.type) {
        case CTF_SET_POINTS:
            return { ...state, points: [...action.payload].sort((a, b) => a.hu - b.hu) };
        default:
            return state;
    }
}

export const rootReducer = combineReducers({
    hello: helloReducer,
    base: baseReducer,
    textureBasedCT: textureBasedCTReducer,
    ctf: ctfReducer,
});

//O shape do state inteiro, derivado do rootReducer — é o tipo que os
//useSelector da UI e os getState das behaviours enxergam.
export type RootState = ReturnType<typeof rootReducer>;
