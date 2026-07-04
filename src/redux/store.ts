//O store: singleton importado pelos DOIS lados da fronteira, no mesmo
//molde dos registries de behaviour/material.
//  - React: via <Provider store={store}> + useSelector/useDispatch;
//  - engine: behaviours leem store.getState() dentro do update() — como
//    já rodam todo frame, o valor novo vale no frame seguinte ao dispatch,
//    sem subscription pra gerenciar (e sem callback segurando node morto
//    depois do destroy() de um mundo).
//
//legacy_createStore É o createStore de sempre — o rename é só o jeito do
//redux 5 empurrar os novatos pro Redux Toolkit sem quebrar quem já sabe
//o que está fazendo.
import { legacy_createStore as createStore } from "redux";
import { rootReducer } from "./reducers";

export const store = createStore(rootReducer);

//O tipo do dispatch DESTE store (aceita AppAction). O useDispatch genérico
//do react-redux não conhece nossas actions — a UI usa useDispatch<AppDispatch>().
export type AppDispatch = typeof store.dispatch;
