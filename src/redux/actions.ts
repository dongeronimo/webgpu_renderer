//Actions: os objetos que se despacham no store pra pedir uma mudança de
//state. Estilo redux clássico: constante de type + action creator à mão.
//
//Convenção da fronteira UI<->renderer: o Redux carrega INTENÇÃO (o que o
//usuário quer, baixa frequência). Estado por-frame da simulação não passa
//por aqui — vive no scene graph e a UI lê por polling (usePolled).

export const HELLO_CLICKED = "HELLO_CLICKED";

export interface HelloClickedAction {
    type: typeof HELLO_CLICKED;
}

export function helloClicked(): HelloClickedAction {
    return { type: HELLO_CLICKED };
}

//União de todas as actions da app — cresce conforme a UI cresce.
export type AppAction = HelloClickedAction;
