//Actions: os objetos que se despacham no store pra pedir uma mudança de
//state. Estilo redux clássico: constante de type + action creator à mão.
//
//Convenção da fronteira UI<->renderer: o Redux carrega INTENÇÃO (o que o
//usuário quer, baixa frequência). Estado por-frame da simulação não passa
//por aqui — vive no scene graph e a UI lê por polling (usePolled).

import type { CtfPoint } from "../ctf";

export const HELLO_CLICKED = "HELLO_CLICKED";
//nome == valor: é o VALOR que aparece em logs/devtools, e grep tem que achar
export const SWITCH_WORLD = "SWITCH_WORLD";

export const TEXTURE_BASED_CT_SET_NUM_SLICES = "TEXTURE_BASED_CT_SET_NUM_SLICES";

export const CTF_SET_POINTS = "CTF_SET_POINTS";

export const SET_ALPHA_SCALE = "SET_ALPHA_SCALE";

export const SET_DEBUG_VIEW_ACTIVE = "SET_DEBUG_VIEW";

//Câmera orbital: o React (OrbitControls) despacha; o reducer acumula yaw e
//clampa pitch; a OrbitCameraBehaviour lê e posiciona o nó da câmera.
export const ORBIT_CAMERA = "ORBIT_CAMERA";
export const ZOOM_CAMERA = "ZOOM_CAMERA";

//Raycaster: o toggle da UI liga/desliga o shading por gradiente on-the-fly;
//a VolumeRaycastBehaviour lê e repassa pro material.
export const SET_RAYCAST_GRADIENT_SHADING = "SET_RAYCAST_GRADIENT_SHADING";
/**
 * Os mundos da app, como union e não string solta — mesmo critério do
 * RenderPassBit: typo morre em compile time. Cresce junto com os mundos.
 */
export type WorldName = "solarSystem" | "textureStackVolumeRenderSynthetic" |
"textureStackVolumeRenderCT" | "StarshipDemo" | "raycast";

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

export interface SetCtfPointsAction {
    type: typeof CTF_SET_POINTS;
    /** A tabela INTEIRA de pontos — o reducer a ordena por HU. */
    payload: CtfPoint[];
}

export interface SetAlphaScaleAction {
    type: typeof SET_ALPHA_SCALE;
    payload: number;
}

export interface SetDebugViewActive {
    type: typeof SET_DEBUG_VIEW_ACTIVE;
    payload: boolean;
}

export interface OrbitCameraAction {
    type: typeof ORBIT_CAMERA;
    /** Deltas de órbita em radianos (já convertidos de pixels no React). */
    payload: { dYaw: number; dPitch: number };
}

export interface ZoomCameraAction {
    type: typeof ZOOM_CAMERA;
    /** Fator multiplicativo do raio (<1 aproxima, >1 afasta). */
    payload: number;
}

export interface SetRaycastGradientShadingAction {
    type: typeof SET_RAYCAST_GRADIENT_SHADING;
    payload: boolean;
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

export function setCtfPoints(points: CtfPoint[]): SetCtfPointsAction {
    return { type: CTF_SET_POINTS, payload: points };
}

export function setAlphaScale(value:number): SetAlphaScaleAction {
    return {type: SET_ALPHA_SCALE, payload: value};
}

export function SetDebugViewActive(value:boolean): SetDebugViewActive {
    return { type: SET_DEBUG_VIEW_ACTIVE, payload: value};
}

export function orbitCamera(dYaw: number, dPitch: number): OrbitCameraAction {
    return { type: ORBIT_CAMERA, payload: { dYaw, dPitch } };
}

export function zoomCamera(factor: number): ZoomCameraAction {
    return { type: ZOOM_CAMERA, payload: factor };
}

export function setRaycastGradientShading(enabled: boolean): SetRaycastGradientShadingAction {
    return { type: SET_RAYCAST_GRADIENT_SHADING, payload: enabled };
}

//União de todas as actions da app — cresce conforme a UI cresce. TODO
//reducer é tipado com ela: no redux, todo reducer recebe TODA action e
//ignora (default) as que não conhece.
export type AppAction =
    | HelloClickedAction
    | SwitchWorldAction
    | SetTextureBasedCTNumSlicesAction
    | SetCtfPointsAction
    | SetAlphaScaleAction
    | SetDebugViewActive
    | OrbitCameraAction
    | ZoomCameraAction
    | SetRaycastGradientShadingAction;
