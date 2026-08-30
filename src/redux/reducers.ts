//Reducers: funções puras (state, action) => novo state. Redux clássico,
//switch e spread — sem toolkit, sem immer.
import { combineReducers } from "redux";
import type { CtfPoint } from "../ctf";
import type { LassoData } from "../raycastLasso/lassoData";
import type { ScalpelData } from "../raycastLasso/scalpelData";
import { defaultWorld } from "../appConfig";
import { CTF_SET_POINTS, GAUNTLET_CHARACTER_CHOSEN, LASSO_ADDED, LASSO_REMOVED, SCALPEL_ADDED, SCALPEL_REMOVED, SET_LASSO_DEBUG_VIEW, SET_SCALPEL_DEBUG_VIEW, SET_SCALPEL_MARGIN, GAUNTLET_CHOOSING_CHARACTER, GAUNTLET_LOGIN_SUCCEEDED, HELLO_CLICKED, ORBIT_CAMERA, SET_ACTIVE_TOOL, SET_ALPHA_SCALE, SET_CTF_HU_RANGE, SET_DEBUG_VIEW_ACTIVE, SET_GAUNTLET_SHADOW_MAP_SIZE, SET_LOADING, SET_RAYCAST_ESS, SET_RAYCAST_ESS_DEBUG, SET_RAYCAST_FRAMEBUFFER_SCALE, SET_RAYCAST_GRADIENT_MODE, SET_RAYCAST_GRADIENT_SHADING, SWITCH_WORLD, TEXTURE_BASED_CT_SET_NUM_SLICES, ZOOM_CAMERA, type AppAction, type GradientMode, type ToolName, type WorldName } from "./actions";

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
    //A tela de carga (modal bloqueante) está de pé? O ctor de qualquer World a
    //liga; o 1º update() dele a desliga (ver world.ts). É estado da app, não
    //de um mundo — por isso mora aqui, junto do currentWorld.
    loading: boolean;
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
    //Faixa de HU do volume carregado (metadata) = eixo X do editor de CTF. O
    //mundo despacha na carga; até lá vale o placeholder inicial.
    huMin: number;
    huMax: number;
}

/**
 * Estado do raycaster. Por ora só o shading por gradiente: enabled é o
 * liga/desliga; mode escolhe entre gradiente pré-calculado (textura 3D) e
 * on-the-fly (diferenças centrais no shader). Ortogonais de propósito — o
 * mode sobrevive ao desligar, então religar volta pro modo que o usuário
 * tinha escolhido. Ainda ninguém CONSOME (a VolumeRaycastBehaviour vai ler);
 * esta etapa é só UI + plumbing.
 */
export interface RaycastState {
    gradientEnabled: boolean;
    gradientMode: GradientMode;
    framebufferScale: number;
    //Empty-space skipping ligado? (mundo raycastESS; on por default pra o world
    //já nascer usando o skip — o toggle serve pra comparar com/sem.)
    essEnabled: boolean;
    //PiP de debug do ESS (cubos dos chunks mantidos) visível?
    essDebugView: boolean;
    //Debug view das máscaras do lasso (mundo raycastLasso): pinta a região dos
    //lassos em vez de removê-la. Mora aqui, junto do essDebugView, porque é a
    //mesma natureza — knob de debug de uma técnica de render, lido pelo
    //material. O que os lassos SÃO mora no slice lasso; isto é só como mostrá-los.
    lassoDebugView: boolean;
    //Idem pro bisturi: pinta a casca (verde-piscina) em vez de removê-la.
    //Toggle separado do lasso porque as duas ferramentas são independentes —
    //dá pra estar olhando o corte de uma enquanto a outra corta pra valer.
    scalpelDebugView: boolean;
}

/**
 * Estado da barra de FERRAMENTAS. Slice próprio (e não campo do raycast) pelo
 * mesmo critério do ctf: "que tool está armada" é modo de INTERAÇÃO da tela,
 * não parâmetro de uma técnica de render — o dia que outro mundo ganhar tools,
 * consome este mesmo slice sem herdar os knobs do raycaster junto.
 *
 * Um ÚNICO campo, e não um booleano por tool: a exclusão mútua vira invariante
 * de tipo em vez de disciplina de quem despacha.
 */
export interface ToolsState {
    activeTool: ToolName;
}

/**
 * Os lassos já fechados, na ordem em que foram desenhados. Slice separado do
 * tools de propósito: "que ferramenta está na mão" é modo de interação e
 * morre na troca de mundo; os lassos são o DOCUMENTO — o trabalho do usuário,
 * que sobrevive a soltar a ferramenta, a trocar de mundo e (quando ela vier)
 * à pilha de undo/redo.
 *
 * Cada item carrega a câmera dele junto (ver LassoData): sem isso, dois lassos
 * desenhados de ângulos diferentes seriam indistinguíveis aqui dentro.
 */
export interface LassoState {
    items: LassoData[];
}

/**
 * Os bisturis já fechados. Slice PRÓPRIO, irmão do lasso e não campo dele: o
 * dado é outro (carrega espessura, e um mapa de profundidade que vive na GPU),
 * e as duas listas crescem e encolhem independentes.
 *
 * margin é a exceção: não é documento, é o ajuste do PRÓXIMO corte — o
 * tamanho do pincel. Cada ScalpelData guarda a margem com que foi feito, então
 * mexer aqui não mexe retroativamente no que já foi cortado.
 */
export interface ScalpelState {
    items: ScalpelData[];
    margin: number;
}

/**
 * Estado da câmera orbital (raycaster). Coordenadas esféricas ao redor da
 * mesh do volume: yaw gira no +Y do mundo, pitch é a elevação (clampada pra
 * o lookAt não degenerar no polo), radius é a distância ao alvo. O React
 * (OrbitControls) escreve; a OrbitCameraBehaviour lê e posiciona o nó.
 */
export interface CameraState {
    yaw: number;
    pitch: number;
    radius: number;
}

/**
 * Estado do mundo gauntlet (multiplayer). A UI escreve (form de login); a
 * GauntletNetworkBehaviour lê no update() e, com loggedIn, dispara os ritos
 * de conexão (signaling → join → /ws/game). A senha NÃO mora aqui de
 * propósito: depois do POST /login a credencial é o cookie de sessão, e
 * state é visível no redux devtools.
 */
export interface GauntletState {
    /** Nome logado ("" = ninguém). Exibição/HUD; a credencial é o cookie. */
    username: string;
    //O gatilho que a behaviour espera pra conectar.
    loggedIn: boolean;
    //flag da tela de escolha de personagem.
    choosingCharacter: boolean;
    //"Dmitry"/"Nat" depois de escolhido no modal (null até lá) — o gatilho
    //que GauntletNetworkBehaviour.update() espera pra buscar o
    //player-controller-settings DESTE personagem e então conectar (ver
    //connectSignaling em GauntletNetwork.ts). Mesma string manda no
    //JoinRequest e nomeia o prefab (gauntletWorld.ts).
    character: string | null;
    //Resolução (px, quadrado) dos shadow maps de spot/directional — o
    //GauntletWorld lê no update() e manda a GauntletLighting redimensionar
    //os render targets (ver gauntletLighting.ts/gauntletWorld.ts). Default
    //igual ao DEFAULT_SHADOW_MAP_SIZE de lá — mantenha os dois em sync.
    shadowMapSize: number;
}

const helloInitial: HelloState = {
    clickCount: 0,
};

const gauntletInitial: GauntletState = {
    username: "",
    loggedIn: false,
    choosingCharacter : false,
    character: null,
    shadowMapSize: 4096,
};

const baseInitial: BaseState = {
    //Boot conforme o domínio (gauntlet.dongeronimo.net → gauntlet, etc.) — o
    //bootWorld do main lê ESTE mesmo valor, então os dois casam. Ver appConfig.
    currentWorld: defaultWorld(),
    //Começa false: quem liga é o ctor do bootWorld (no main), que roda antes
    //da UI montar — quando o React aparece o valor já reflete o mundo em carga.
    loading: false,
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
    //placeholder até um mundo despachar a faixa real do exame (metadata)
    huMin: -1000,
    huMax: 1500,
};

//Gradiente começa desligado; quando ligar, o default é on-the-fly (não custa
//o pré-passo nem a VRAM da textura 3D).
const raycastInitial: RaycastState = {
    gradientEnabled: false,
    gradientMode: "on-the-fly",
    framebufferScale : 1.0,
    essEnabled: true,
    essDebugView: true,
    //off por default: com lasso nenhum desenhado ele não faria nada mesmo, e
    //ligado por engano esconderia que o corte ainda não está cortando.
    lassoDebugView: false,
    scalpelDebugView: false,
};

//Pitch máximo (~89°): abaixo do polo, onde o up (0,1,0) do lookAt ficaria
//paralelo à direção de visão e a orientação degeneraria.
const MAX_PITCH = (89 * Math.PI) / 180;
const MIN_RADIUS = 0.6;
const MAX_RADIUS = 8;

//Valor inicial calibrado pra reproduzir o enquadramento anterior do
//raycaster: yaw 0, leve elevação, ~2.3 de distância → câmera em (0, 0.6, 2.2).
const cameraInitial: CameraState = {
    yaw: 0,
    pitch: (15 * Math.PI) / 180,
    radius: 2.3,
};

function cameraReducer(state: CameraState = cameraInitial, action: AppAction): CameraState {
    switch (action.type) {
        case ORBIT_CAMERA: {
            const yaw = state.yaw + action.payload.dYaw;
            const pitch = Math.min(Math.max(state.pitch + action.payload.dPitch, -MAX_PITCH), MAX_PITCH);
            return { ...state, yaw, pitch };
        }
        case ZOOM_CAMERA: {
            const radius = Math.min(Math.max(state.radius * action.payload, MIN_RADIUS), MAX_RADIUS);
            return { ...state, radius };
        }
        default:
            return state;
    }
}

//loggedIn sobrevive à troca de mundo de propósito: a sessão HTTP continua
//válida, então voltar pro gauntlet reconecta sem pedir login de novo.
function gauntletReducer(state: GauntletState = gauntletInitial, action: AppAction): GauntletState {
    switch (action.type) {
        case GAUNTLET_LOGIN_SUCCEEDED:
            return { ...state, username: action.payload.username, loggedIn: true };
        case SET_GAUNTLET_SHADOW_MAP_SIZE:
            return { ...state, shadowMapSize: action.payload };
        case GAUNTLET_CHOOSING_CHARACTER:
            return { ...state, choosingCharacter: action.payload };
        case GAUNTLET_CHARACTER_CHOSEN:
            //escolha concluída: fecha o modal junto, senão sobra um frame
            //onde character já não é null mas o modal ainda está de pé.
            return { ...state, character: action.payload.character, choosingCharacter: false };
        default:
            return state;
    }
}

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
        case SET_LOADING:
            return { ...state, loading: action.payload };
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

function raycastReducer(state: RaycastState = raycastInitial, action: AppAction): RaycastState {
    switch (action.type) {
        case SET_RAYCAST_GRADIENT_SHADING:
            return { ...state, gradientEnabled: action.payload };
        case SET_RAYCAST_GRADIENT_MODE:
            return { ...state, gradientMode: action.payload };
        case SET_RAYCAST_FRAMEBUFFER_SCALE:
            return { ...state, framebufferScale: action.payload };
        case SET_RAYCAST_ESS:
            return { ...state, essEnabled: action.payload };
        case SET_RAYCAST_ESS_DEBUG:
            return { ...state, essDebugView: action.payload };
        case SET_LASSO_DEBUG_VIEW:
            return { ...state, lassoDebugView: action.payload };
        case SET_SCALPEL_DEBUG_VIEW:
            return { ...state, scalpelDebugView: action.payload };
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
        case SET_CTF_HU_RANGE:
            return { ...state, huMin: action.payload.min, huMax: action.payload.max };
        default:
            return state;
    }
}

//"none" = modo câmera: é onde a tela nasce, com o drag orbitando.
const toolsInitial: ToolsState = { activeTool: "none" };

function toolsReducer(state: ToolsState = toolsInitial, action: AppAction): ToolsState {
    switch (action.type) {
        case SET_ACTIVE_TOOL:
            return { ...state, activeTool: action.payload };
        //Trocar de mundo DESARMA a ferramenta. Senão o lasso continua armado
        //num mundo que nem tem barra de tools — estado fantasma que só aparece
        //quando o usuário volta e o botão está aceso sem ele ter clicado nada.
        //Guarda o mesmo objeto quando já é "none": troca de mundo é frequente e
        //referência nova à toa faz a UI re-renderizar sem motivo.
        case SWITCH_WORLD:
            return state.activeTool === "none" ? state : { ...state, activeTool: "none" };
        default:
            return state;
    }
}

const lassoInitial: LassoState = { items: [] };
//Margem ZERO por default: quem define a espessura do corte é a camada medida
//no mapa, não este slider. Ele existe pra corrigir uma camada que termina cedo
//demais, e o valor certo na maioria dos casos é nenhum.
const scalpelInitial: ScalpelState = { items: [], margin: 0 };

//Array NOVO a cada mudança (nunca push in-place): é a troca de referência que
//a behaviour do material vai detectar pra reenviar os lassos pra GPU, o mesmo
//contrato do ctfReducer.
function lassoReducer(state: LassoState = lassoInitial, action: AppAction): LassoState {
    switch (action.type) {
        case LASSO_ADDED:
            return { ...state, items: [...state.items, action.payload] };
        case LASSO_REMOVED:
            return { ...state, items: state.items.filter((l) => l.id !== action.payload) };
        //SEM reset no SWITCH_WORLD, ao contrário do tools: sair do mundo e
        //voltar não pode jogar fora o recorte que o usuário fez — as matrizes
        //continuam válidas (o model do volume é remontado idêntico).
        default:
            return state;
    }
}

function scalpelReducer(state: ScalpelState = scalpelInitial, action: AppAction): ScalpelState {
    switch (action.type) {
        case SCALPEL_ADDED:
            return { ...state, items: [...state.items, action.payload] };
        case SCALPEL_REMOVED:
            return { ...state, items: state.items.filter((sc) => sc.id !== action.payload) };
        case SET_SCALPEL_MARGIN:
            return { ...state, margin: action.payload };
        //Sem reset no SWITCH_WORLD, igual ao lasso: é o trabalho do usuário.
        default:
            return state;
    }
}

export const rootReducer = combineReducers({
    hello: helloReducer,
    base: baseReducer,
    textureBasedCT: textureBasedCTReducer,
    ctf: ctfReducer,
    camera: cameraReducer,
    raycast: raycastReducer,
    tools: toolsReducer,
    lasso: lassoReducer,
    scalpel: scalpelReducer,
    gauntlet: gauntletReducer,
});

//O shape do state inteiro, derivado do rootReducer — é o tipo que os
//useSelector da UI e os getState das behaviours enxergam.
export type RootState = ReturnType<typeof rootReducer>;
