//Reducers: funções puras (state, action) => novo state. Redux clássico,
//switch e spread — sem toolkit, sem immer.
import { combineReducers } from "redux";
import { HELLO_CLICKED, type AppAction } from "./actions";

export interface HelloState {
    /** Quantas vezes o botão de hello foi clicado. */
    clickCount: number;
}

const helloInitial: HelloState = {
    clickCount: 0,
};

function helloReducer(state: HelloState = helloInitial, action: AppAction): HelloState {
    switch (action.type) {
        case HELLO_CLICKED:
            return { ...state, clickCount: state.clickCount + 1 };
        default:
            return state;
    }
}

export const rootReducer = combineReducers({
    hello: helloReducer,
});

//O shape do state inteiro, derivado do rootReducer — é o tipo que os
//useSelector da UI e os getState das behaviours enxergam.
export type RootState = ReturnType<typeof rootReducer>;
