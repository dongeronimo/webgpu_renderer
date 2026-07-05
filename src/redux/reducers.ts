//Reducers: funções puras (state, action) => novo state. Redux clássico,
//switch e spread — sem toolkit, sem immer.
import { combineReducers } from "redux";
import { HELLO_CLICKED, SWITCH_WORLD, type AppAction, type WorldName } from "./actions";

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

const helloInitial: HelloState = {
    clickCount: 0,
};

const baseInitial: BaseState = {
    currentWorld: "textureStackVolumeRenderSynthetic",
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

export const rootReducer = combineReducers({
    hello: helloReducer,
    base: baseReducer,
});

//O shape do state inteiro, derivado do rootReducer — é o tipo que os
//useSelector da UI e os getState das behaviours enxergam.
export type RootState = ReturnType<typeof rootReducer>;
