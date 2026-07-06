//Actions: os objetos que se despacham no store pra pedir uma mudança de
//state. Estilo redux clássico: constante de type + action creator à mão.
//
//Convenção da fronteira UI<->renderer: o Redux carrega INTENÇÃO (o que o
//usuário quer, baixa frequência). Estado por-frame da simulação não passa
//por aqui — vive no scene graph e a UI lê por polling (usePolled).

export const HELLO_CLICKED = "HELLO_CLICKED";
//nome == valor: é o VALOR que aparece em logs/devtools, e grep tem que achar
export const SWITCH_WORLD = "SWITCH_WORLD";

export const TEXTURE_BASED_CT_SET_NUM_SLICES = "TEXTURE_BASED_CT_SET_NUM_SLICES";

/**
 * Os mundos da app, como union e não string solta — mesmo critério do
 * RenderPassBit: typo morre em compile time. Cresce junto com os mundos.
 */
export type WorldName = "solarSystem" | "textureStackVolumeRenderSynthetic" | "textureStackVolumeRenderCT";

export interface HelloClickedAction {
    type: typeof HELLO_CLICKED;
}
export interface SwitchWorldAction {
    type: typeof SWITCH_WORLD;
    payload: WorldName;
}

export interface SetTextureBasedCTNumSlicesAction {
    type: typeof TEXTURE_BASED_CT_SET_NUM_SLICES;
    payload: number;
}
export function helloClicked(): HelloClickedAction {
    return { type: HELLO_CLICKED };
}

export function switchWorld(world: WorldName): SwitchWorldAction {
    return { type: SWITCH_WORLD, payload: world };
}

export function setTextureBasedCTNumSlices(val:number):SetTextureBasedCTNumSlicesAction{
    return {type: TEXTURE_BASED_CT_SET_NUM_SLICES, payload: val};
}


//União de todas as actions da app — cresce conforme a UI cresce. TODO
//reducer é tipado com ela: no redux, todo reducer recebe TODA action e
//ignora (default) as que não conhece.
export type AppAction = HelloClickedAction | SwitchWorldAction | SetTextureBasedCTNumSlicesAction;
