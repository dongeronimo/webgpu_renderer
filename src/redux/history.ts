//UNDO/REDO por AÇÃO INVERSA.
//
//Nada de guardar snapshots do state. Toda edição desfazível tem uma ação que a
//desfaz, e desfazer é DESPACHAR essa inversa pelos mesmos reducers de sempre —
//o state continua sendo, sempre, o resultado de uma sequência de ações. É o que
//o redux dá de melhor, e é o que faz um bug de undo ser reproduzível: basta a
//lista de ações.
//
//A regra que faz isso funcionar: a inversa tem que ser construível SÓ com a
//ação, sem olhar o state. Por isso as ações de remoção carregam o DADO INTEIRO
//no payload, e não só o id — sem isso, inverter uma remoção exigiria pescar o
//item removido em algum lugar, e o inverter deixaria de ser uma função pura de
//uma linha. O preço é um payload maior numa ação que acontece uma vez por
//clique; a compra é uma involução:
//
//    invertAction(invertAction(a)) === a
//
//O QUE É DESFAZÍVEL: só as edições do documento (lassos e bisturis). Mexer na
//CTF, na câmera, na margem ou nos toggles devolve null aqui, e ação que não
//tem inversa simplesmente não encosta nas pilhas — nem empilha, nem limpa o
//redo. Ou seja: mudar a CTF no meio e ainda assim conseguir refazer um corte é
//comportamento pretendido, não descuido.
import {
    LASSO_ADDED,
    LASSO_REMOVED,
    SCALPEL_ADDED,
    SCALPEL_REMOVED,
    lassoAdded,
    lassoRemoved,
    scalpelAdded,
    scalpelRemoved,
    type AppAction,
} from "./actions";

/** As duas pilhas. Guardam AÇÕES, não estados. */
export interface HistoryState {
    /** Inversas do que já aconteceu; o topo é a próxima a rodar num undo. */
    undo: AppAction[];
    /** O que foi desfeito, pronto pra ser refeito. O topo é o próximo redo. */
    redo: AppAction[];
}

export const historyInitial: HistoryState = { undo: [], redo: [] };

/**
 * A ação que desfaz a ação dada, ou null se ela não for desfazível.
 *
 * Involução: aplicar duas vezes devolve a original. É isso que deixa o
 * rootReducer tratar undo e redo com o mesmo código, só trocando as pilhas de
 * lado.
 */
export function invertAction(action: AppAction): AppAction | null {
    switch (action.type) {
        case LASSO_ADDED:
            return lassoRemoved(action.payload);
        case LASSO_REMOVED:
            return lassoAdded(action.payload);
        case SCALPEL_ADDED:
            return scalpelRemoved(action.payload);
        case SCALPEL_REMOVED:
            return scalpelAdded(action.payload);
        default:
            return null;
    }
}
