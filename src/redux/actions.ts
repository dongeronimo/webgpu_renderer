//Actions: os objetos que se despacham no store pra pedir uma mudança de
//state. Estilo redux clássico: constante de type + action creator à mão.
//
//Convenção da fronteira UI<->renderer: o Redux carrega INTENÇÃO (o que o
//usuário quer, baixa frequência). Estado por-frame da simulação não passa
//por aqui — vive no scene graph e a UI lê por polling (usePolled).

import type { CtfPoint } from "../ctf";
import type { LassoData } from "../raycastLasso/lassoData";
import type { ScalpelData } from "../raycastLasso/scalpelData";

export const HELLO_CLICKED = "HELLO_CLICKED";
//nome == valor: é o VALOR que aparece em logs/devtools, e grep tem que achar
export const SWITCH_WORLD = "SWITCH_WORLD";

//Tela de carga (modal bloqueante da UI base): o ctor do World a levanta e o
//1º update() dele a baixa — ver world.ts. Flag no base (não num mundo) porque
//a tela é da app: sobrevive à troca de mundo, igual ao WorldSwitch. O modal é
//só um spinner, SEM barra de progresso de propósito — a carga (fetch de assets
//+ upload pra GPU) não tem como ser contabilizada em porcentagem.
export const SET_LOADING = "SET_LOADING";

export const TEXTURE_BASED_CT_SET_NUM_SLICES = "TEXTURE_BASED_CT_SET_NUM_SLICES";

export const CTF_SET_POINTS = "CTF_SET_POINTS";
//A faixa de HU do volume carregado (metadata) — o eixo X do editor de CTF. O
//mundo despacha na carga; a UI lê pro domínio do gráfico. É metadata de carga
//(baixa frequência), não estado por-frame, então cabe no redux.
export const SET_CTF_HU_RANGE = "SET_CTF_HU_RANGE";

export const SET_ALPHA_SCALE = "SET_ALPHA_SCALE";

export const SET_DEBUG_VIEW_ACTIVE = "SET_DEBUG_VIEW";

//Câmera orbital: o React (OrbitControls) despacha; o reducer acumula yaw e
//clampa pitch; a OrbitCameraBehaviour lê e posiciona o nó da câmera.
export const ORBIT_CAMERA = "ORBIT_CAMERA";
export const ZOOM_CAMERA = "ZOOM_CAMERA";

//Raycaster: o toggle da UI liga/desliga o shading por gradiente; a
//VolumeRaycastBehaviour lê e repassa pro material. ENABLE e MODE são
//ortogonais: enable é o liga/desliga; mode escolhe COMO o gradiente é obtido
//(pré-calculado numa textura 3D vs. calculado on-the-fly no shader). O mode
//continua no state mesmo com o gradiente desligado — é a preferência que
//volta a valer quando religa.
export const SET_RAYCAST_GRADIENT_SHADING = "SET_RAYCAST_GRADIENT_SHADING";
export const SET_RAYCAST_GRADIENT_MODE = "SET_RAYCAST_GRADIENT_MODE";
//A primeira e mais brutal otimização de raycast é reduzir o framebuffer.
//Menos fragmentos = menos raios.
export const SET_RAYCAST_FRAMEBUFFER_SCALE = "SET_RAYCAST_FRAMEBUFFER_SCALE";
//Empty-space skipping (mundo raycastESS): liga/desliga o skip de chunks vazios,
//pra comparar velocidade com/sem. A VolumeRaycastESSBehaviour lê e repassa.
export const SET_RAYCAST_ESS = "SET_RAYCAST_ESS";
//PiP de debug do ESS: liga/desliga o quadzinho com os cubos dos chunks mantidos.
//Gateia PASSES de render (lido no render() do world), não é estado de nó.
export const SET_RAYCAST_ESS_DEBUG = "SET_RAYCAST_ESS_DEBUG";
//Debug view das MÁSCARAS do lasso (mundo raycastLasso): em vez de remover a
//região dos lassos, o raymarch a PINTA. Diferente do debug do ESS, que é um
//pass próprio num PiP, este vive dentro do próprio raycaster — a região só
//existe projetada ao longo do raio, então precisa do volume renderer pra
//aparecer. Vai pros params do material (a behaviour lê e repassa).
export const SET_LASSO_DEBUG_VIEW = "SET_LASSO_DEBUG_VIEW";
//BISTURI. Actions próprias e não um "modo" das do lasso: o que ele produz é
//outro dado (ScalpelData, com mapa de profundidade e espessura) e o efeito é
//outro (descasca em vez de furar). Misturar os dois num payload só economizaria
//três constantes e custaria a independência das duas ferramentas.
export const SCALPEL_ADDED = "SCALPEL_ADDED";
export const SCALPEL_REMOVED = "SCALPEL_REMOVED";
//Margem do PRÓXIMO corte (o já feito guarda a dele) — o "tamanho do pincel".
//Margem e não espessura: a espessura quem dá é a estrutura.
export const SET_SCALPEL_MARGIN = "SET_SCALPEL_MARGIN";
export const SET_SCALPEL_DEBUG_VIEW = "SET_SCALPEL_DEBUG_VIEW";
//UNDO/REDO. Não carregam payload: o que fazer está nas pilhas do state, e quem
//aplica é o rootReducer, despachando a ação inversa pelos reducers de sempre
//(ver history.ts). A UI só pede "desfaz" — não sabe o que vai ser desfeito.
export const HISTORY_UNDO = "HISTORY_UNDO";
export const HISTORY_REDO = "HISTORY_REDO";
//Ferramenta ARMADA na barra de tools (mundo raycastLasso por ora). O state é
//UM valor e não um conjunto de flags de propósito: a exclusão mútua fica
//ESTRUTURAL — não existe estado representável com dois tools armados pra
//alguém esquecer de desligar. Quem consome é a UI (qual botão está aceso) e,
//da F1 em diante, o overlay de captura (quem come os eventos do ponteiro).
export const SET_ACTIVE_TOOL = "SET_ACTIVE_TOOL";
//Um lasso foi FECHADO (o usuário soltou o botão) ou REMOVIDO (botão direito).
//É intenção de baixa frequência — um punhado de eventos por sessão, cada um
//uma edição que o usuário vai querer desfazer —, então cabe no redux mesmo
//carregando uma matriz dentro. O que NÃO passaria por aqui é o traço em
//andamento: esse é por-frame e vive no overlay até fechar.
export const LASSO_ADDED = "LASSO_ADDED";
export const LASSO_REMOVED = "LASSO_REMOVED";
//Gauntlet: o form de login (UI) fez o POST /login e o server aceitou — a
//credencial REAL daqui em diante é o cookie de sessão, não user/senha (por
//isso a senha nunca entra no state: nenhum consumidor precisa dela depois
//do fetch, e o devtools do redux mostra o store inteiro). A
//GauntletNetworkBehaviour lê a flag no update() e dispara signaling+game.
export const GAUNTLET_LOGIN_SUCCEEDED = "GAUNTLET_LOGIN_SUCCEEDED";
//Resolução dos shadow maps de spot/directional (px, quadrado). A UI escreve
//(campo de texto); o GauntletWorld lê no update() (padrão lastSeen) e manda
//a GauntletLighting redimensionar os render targets — ver gauntletWorld.ts.
export const SET_GAUNTLET_SHADOW_MAP_SIZE = "SET_GAUNTLET_SHADOW_MAP_SIZE";
//A tela de escolha de personagens é um modal exibido depois do log in bem
//sucedido (e portanto depois de ter passado das barreiras do spring security
//e estar num ambiente confiável)
export const GAUNTLET_CHOOSING_CHARACTER = "GAUNTLET_CHOOSING_CHARACTER";
//O player concluiu a escolha no modal (Dmitry/Nat) — fecha o modal e destrava
//o resto do rito de conexão (GauntletNetworkBehaviour.update() lê
//gauntlet.character pra saber que pode buscar o player-controller-settings
//DESTE personagem e então abrir o signaling com o character no JoinRequest).
export const GAUNTLET_CHARACTER_CHOSEN = "GAUNTLET_CHARACTER_CHOSEN";
//Como o gradiente é obtido. "precalculated": uma textura 3D de gradientes
//gerada uma vez (rápido no raymarch, custa VRAM e um pré-passo). "on-the-fly":
//diferenças centrais amostradas no próprio shader a cada passo (zero memória
//extra, mais amostras por passo). String union: typo morre em compile time.
export type GradientMode = "precalculated" | "on-the-fly";
/**
 * Os mundos da app, como union e não string solta — mesmo critério do
 * RenderPassBit: typo morre em compile time. Cresce junto com os mundos.
 */
export type WorldName =
    "solarSystem" |
    "textureStackVolumeRenderSynthetic" |
    "textureStackVolumeRenderCT" |
    "StarshipDemo" |
    "raycast" |
    "raycastESS" |
    "raycastLasso" |
    "gameVolume" |
    "train" |
    "SkinningDemo" |
    "gauntlet";

/**
 * As ferramentas da barra de tools, como union pelo mesmo motivo do WorldName:
 * typo morre em compile time. Cresce junto com os tools.
 *
 * "none" NÃO é ausência de modo — é o modo CÂMERA, aquele em que arrastar
 * orbita. É por isso que ele aparece na UI como um botão de verdade ("Câmera")
 * e não como "nenhum botão aceso": num radiogroup sempre tem exatamente um
 * selecionado, e o usuário precisa enxergar em que modo está.
 */
export type ToolName = "none" | "lasso" | "scalpel";

export interface HelloClickedAction {
    type: typeof HELLO_CLICKED;
}
export interface SwitchWorldAction {
    type: typeof SWITCH_WORLD;
    payload: WorldName;
}

export interface SetLoadingAction {
    type: typeof SET_LOADING;
    payload: boolean;
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

export interface SetCtfHuRangeAction {
    type: typeof SET_CTF_HU_RANGE;
    payload: { min: number; max: number };
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

export interface SetRaycastGradientModeAction {
    type: typeof SET_RAYCAST_GRADIENT_MODE;
    payload: GradientMode;
}

export interface SetRaycastFramebufferScaleAction {
    type: typeof SET_RAYCAST_FRAMEBUFFER_SCALE;
    payload: number;
}

export interface SetRaycastEssAction {
    type: typeof SET_RAYCAST_ESS;
    payload: boolean;
}

export interface SetRaycastEssDebugAction {
    type: typeof SET_RAYCAST_ESS_DEBUG;
    payload: boolean;
}

export interface ScalpelAddedAction {
    type: typeof SCALPEL_ADDED;
    payload: ScalpelData;
}

export interface ScalpelRemovedAction {
    type: typeof SCALPEL_REMOVED;
    /** O bisturi inteiro, pelo mesmo motivo do LassoRemovedAction. */
    payload: ScalpelData;
}

export interface SetScalpelMarginAction {
    type: typeof SET_SCALPEL_MARGIN;
    payload: number;
}

export interface SetScalpelDebugViewAction {
    type: typeof SET_SCALPEL_DEBUG_VIEW;
    payload: boolean;
}

export interface HistoryUndoAction {
    type: typeof HISTORY_UNDO;
}

export interface HistoryRedoAction {
    type: typeof HISTORY_REDO;
}

export interface SetLassoDebugViewAction {
    type: typeof SET_LASSO_DEBUG_VIEW;
    payload: boolean;
}

export interface LassoAddedAction {
    type: typeof LASSO_ADDED;
    payload: LassoData;
}

export interface LassoRemovedAction {
    type: typeof LASSO_REMOVED;
    /**
     * O lasso INTEIRO, não só o id. O reducer só usa o payload.id pra filtrar,
     * mas o resto tem que estar aqui pra o undo conseguir reconstruir a ação
     * que ressuscita o lasso sem consultar o state — ver history.ts.
     */
    payload: LassoData;
}

export interface SetActiveToolAction {
    type: typeof SET_ACTIVE_TOOL;
    payload: ToolName;
}

export interface GauntletLoginSucceededAction {
    type: typeof GAUNTLET_LOGIN_SUCCEEDED;
    /** Quem logou — pra UI exibir e pro futuro HUD; a credencial é o cookie. */
    payload: { username: string };
}

export interface SetGauntletShadowMapSizeAction {
    type: typeof SET_GAUNTLET_SHADOW_MAP_SIZE;
    payload: number;
}

export interface GauntletSetCharacterScreenAction {
    type: typeof GAUNTLET_CHOOSING_CHARACTER;
    payload: boolean;
}

export interface GauntletCharacterChosenAction {
    type: typeof GAUNTLET_CHARACTER_CHOSEN;
    /** "Dmitry" ou "Nat" — mesma string usada como nome do prefab (ver
     *  gauntletWorld.ts) e mandada pro server em JoinRequest.character. */
    payload: { character: string };
}

export function helloClicked(): HelloClickedAction {
    return { type: HELLO_CLICKED };
}

export function switchWorld(world: WorldName): SwitchWorldAction {
    return { type: SWITCH_WORLD, payload: world };
}

//Dois creators nomeados (como o gauntletShow/HideCharacterSelectionScreen) pra
//os call sites lerem bem: o ctor do World chama show, o 1º update() chama hide.
export function showLoadingScreen(): SetLoadingAction {
    return { type: SET_LOADING, payload: true };
}

export function hideLoadingScreen(): SetLoadingAction {
    return { type: SET_LOADING, payload: false };
}

export function setTextureBasedCTNumSlices(val:number):SetTextureBasedCTNumSlicesAction{
    return {type: TEXTURE_BASED_CT_SET_NUM_SLICES, payload: val};
}

export function setCtfPoints(points: CtfPoint[]): SetCtfPointsAction {
    return { type: CTF_SET_POINTS, payload: points };
}

export function setCtfHuRange(min: number, max: number): SetCtfHuRangeAction {
    return { type: SET_CTF_HU_RANGE, payload: { min, max } };
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

export function setRaycastGradientMode(mode: GradientMode): SetRaycastGradientModeAction {
    return { type: SET_RAYCAST_GRADIENT_MODE, payload: mode };
}

export function setRaycastFramebufferScale(val:number) : SetRaycastFramebufferScaleAction {
    return {type: SET_RAYCAST_FRAMEBUFFER_SCALE, payload:val};
}

export function setRaycastEmptySpaceSkip(enabled: boolean): SetRaycastEssAction {
    return { type: SET_RAYCAST_ESS, payload: enabled };
}

export function setRaycastEssDebugView(enabled: boolean): SetRaycastEssDebugAction {
    return { type: SET_RAYCAST_ESS_DEBUG, payload: enabled };
}

export function scalpelAdded(scalpel: ScalpelData): ScalpelAddedAction {
    return { type: SCALPEL_ADDED, payload: scalpel };
}

export function scalpelRemoved(scalpel: ScalpelData): ScalpelRemovedAction {
    return { type: SCALPEL_REMOVED, payload: scalpel };
}

export function setScalpelMargin(margin: number): SetScalpelMarginAction {
    return { type: SET_SCALPEL_MARGIN, payload: margin };
}

export function setScalpelDebugView(enabled: boolean): SetScalpelDebugViewAction {
    return { type: SET_SCALPEL_DEBUG_VIEW, payload: enabled };
}

export function setLassoDebugView(enabled: boolean): SetLassoDebugViewAction {
    return { type: SET_LASSO_DEBUG_VIEW, payload: enabled };
}

export function lassoAdded(lasso: LassoData): LassoAddedAction {
    return { type: LASSO_ADDED, payload: lasso };
}

export function lassoRemoved(lasso: LassoData): LassoRemovedAction {
    return { type: LASSO_REMOVED, payload: lasso };
}

export function undo(): HistoryUndoAction {
    return { type: HISTORY_UNDO };
}

export function redo(): HistoryRedoAction {
    return { type: HISTORY_REDO };
}

export function setActiveTool(tool: ToolName): SetActiveToolAction {
    return { type: SET_ACTIVE_TOOL, payload: tool };
}

export function gauntletLoginSucceeded(username: string): GauntletLoginSucceededAction {
    return { type: GAUNTLET_LOGIN_SUCCEEDED, payload: { username } };
}

export function setGauntletShadowMapSize(size: number): SetGauntletShadowMapSizeAction {
    return { type: SET_GAUNTLET_SHADOW_MAP_SIZE, payload: size };
}

export function gauntletShowCharacterSelectionScreen():GauntletSetCharacterScreenAction {
    return {type:GAUNTLET_CHOOSING_CHARACTER, payload: true};
}

export function gauntletHideCharacterSelectionScreen():GauntletSetCharacterScreenAction {
    return {type:GAUNTLET_CHOOSING_CHARACTER, payload: false};
}

export function gauntletCharacterChosen(character: string): GauntletCharacterChosenAction {
    return { type: GAUNTLET_CHARACTER_CHOSEN, payload: { character } };
}
//União de todas as actions da app — cresce conforme a UI cresce. TODO
//reducer é tipado com ela: no redux, todo reducer recebe TODA action e
//ignora (default) as que não conhece.
export type AppAction =
    | HelloClickedAction
    | SwitchWorldAction
    | SetLoadingAction
    | SetTextureBasedCTNumSlicesAction
    | SetCtfPointsAction
    | SetCtfHuRangeAction
    | SetAlphaScaleAction
    | SetDebugViewActive
    | OrbitCameraAction
    | ZoomCameraAction
    | SetRaycastGradientShadingAction
    | SetRaycastGradientModeAction
    | SetRaycastFramebufferScaleAction
    | SetRaycastEssAction
    | SetRaycastEssDebugAction
    | SetActiveToolAction
    | SetLassoDebugViewAction
    | ScalpelAddedAction
    | ScalpelRemovedAction
    | SetScalpelMarginAction
    | SetScalpelDebugViewAction
    | HistoryUndoAction
    | HistoryRedoAction
    | LassoAddedAction
    | LassoRemovedAction
    | GauntletLoginSucceededAction
    | SetGauntletShadowMapSizeAction
    | GauntletSetCharacterScreenAction
    | GauntletCharacterChosenAction;
