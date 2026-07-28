import { utils, vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour"
import PrefabFabricator from "../PrefabFabricator";
import { joinRequest } from "./dto/JoinMessage";
import { Node } from "../node";
import { SpotLight } from "../Light";
import { store } from "../redux/store";
import { gauntletShowCharacterSelectionScreen } from "../redux/actions";
import type { EntityDto, GameServerMessage, MapCellDto, MapSyncMessage } from "./dto/ServerMessage";
import { GauntletMap, MapExtras } from "./gauntletMap";
import { GRASS_MAX_BLADES_PER_CELL, GRASS_PREFAB, decodeGrassSeed, generateGrassBlades } from "./grass";
import type { PlayerControllerSettingsDto } from "./dto/PlayerControllerSettingsDto";
import { destroyInstance } from "../prefab";
import MineAvatarBehaviour from "./MineAvatarBehaviour";
import NetworkedEntityBehaviour from "./NetworkedEntityBehaviour";
import CameraFollowBehaviour from "./CameraFollowBehaviour";
import { netSim } from "./netSim";
import { netStats } from "./netStats";
import { PROTOCOL_VERSION, assertProtocol } from "./protocol";
import { backendBase } from "../appConfig";


//yaw chega do server em RADIANOS (Math.atan2 java); node.eulerAngles do
//client quer GRAUS (ver node.ts, quat.fromEuler) — a conversão mora aqui,
//não do lado do server, que não devia saber nada de convenção de client.
const RAD_TO_DEG = 180 / Math.PI;

//Tipo de célula (dado, vindo do server) → prefab (arte, local). É a ÚNICA
//tradução entre os dois mundos: o server não sabe nome de prefab e o client
//não hardcoda geometria por posição. Tipo que não estiver na tabela cai no
//fallback e loga UMA vez — buraco no mundo é pior que a arte errada, e um
//server mais novo (tipo novo) tem que degradar, não quebrar.
const FLOOR_PREFAB_BY_TYPE: Record<string, string> = { dirtGround: "Floor00" };
const WALL_PREFAB_BY_TYPE: Record<string, string> = { basicWall: "Wall00" };
const FALLBACK_FLOOR_PREFAB = "Floor00";
const FALLBACK_WALL_PREFAB = "Wall00";
const warnedCellTypes = new Set<string>();

function prefabForCellType(table: Record<string, string>, type: string, fallback: string): string {
    const prefab = table[type];
    if (prefab !== undefined) return prefab;
    if (!warnedCellTypes.has(type)) {
        warnedCellTypes.add(type); //uma vez por tipo, não uma por célula (seriam centenas)
        console.warn(`GauntletNetwork: tipo de célula desconhecido "${type}", usando ${fallback}`);
    }
    return fallback;
}

class InstanceData {
    public readonly myId:number;
    public readonly instanceId:number;
    public readonly tickRate:number;
    constructor(myId:number, instanceId:number, tickRate:number){
        this.myId = myId;
        this.instanceId = instanceId;
        this.tickRate = tickRate;
    }
}

export default class GauntletNetworkBehaviour extends Behaviour{
    private wsSignaling!: WebSocket;
    private wsGame!: WebSocket;
    //id do setInterval do ping do medidor de lag (ver connectGame/sendPing);
    //limpo no dispose pra não vazar timer.
    private pingTimer: number | undefined;
    //guarda a behaviour, não o Node cru: ela já tem .node (herdado de
    //Behaviour) e é quem sabe aplicar snap/dead reckoning desta entidade —
    //ver NetworkedEntityBehaviour.
    private entities = new Map<number, NetworkedEntityBehaviour>();
    private mapNode!: Node;
    //filho do Map só pra vegetação — ver onMapSync.
    private grassNode!: Node;
    //contadores do log de uma linha do mapSync (quantas células ganharam grama
    //e quantos tufos saíram) — é o termômetro de "o dado chegou?" enquanto o
    //gerador está sendo escrito.
    private grassCells = 0;
    private grassBlades = 0;
    //gerador estourando o teto por célula avisa uma vez, não uma por célula
    private warnedGrassOverflow = false;
    //container irmão do Map: pawns de player, separado pra não confundir
    //teardown de mapa (estático, nunca destrói) com teardown de entidade
    //(despawn destrói o node individual)
    private entitiesNode!: Node;
    //seq do input, sobe 1 por envio (20 Hz). Começa em 1 (não 0) porque o ack
    //default do server é 0 = "nenhum input processado"; assim ack=0 nunca casa
    //com um seq real do histórico e o reconcile pula limpo até o server
    //processar o primeiro input. Ver MineAvatarBehaviour.reconcile.
    private inputSeq = 1;
    // Will be defined after i get the welcome response, so we can check it to test if we are fully in the instance
    private instanceData: InstanceData|undefined = undefined;
    //Os ritos de conexão já foram disparados? (o update roda todo frame e a
    //flag do redux fica true pra sempre — sem isto seria um socket por frame)
    private connectionStarted = false;
    //"Dmitry"/"Nat" — guardado aqui depois do fetch de player-controller-settings
    //(connectSignaling) pra openSignalingSocket montar o JoinRequest com o
    //MESMO valor que já foi usado pra calibrar a predição local.
    private character!: string;
    //Parâmetros de movimento do server (GameLoop/PlayerControllerSettings) —
    //buscados por GET /api/player-controller-settings/{character} em
    //connectSignaling(), ANTES de abrir qualquer socket, então MineAvatarBehaviour
    //(que só nasce depois do stateSync, bem mais tarde no fluxo) já lê os
    //valores reais. Os números aqui são só fallback se o fetch falhar (ver
    //catch) — nunca deveriam ser o que está de fato em uso.
    moveSpeedForward = 3.0;
    moveSpeedBackward = 1.5;
    accel = 20.0;
    angularVelocityDegPerSec = 90.0;
    //abaixo desta velocidade-ao-longo-do-forward (células/s) conta como idle —
    //MESMO valor do server (GameLoop.Movement.stateEpsilon) pra o state local
    //(MineAvatarBehaviour) não piscar na fronteira. Fallback se o fetch falhar.
    moveStateEpsilon = 0.05;
    playerRadius = 0.3;
    //parado gira mais rápido que andando (ver GameLoop.stepMovement) — este
    //é o multiplicador; MineAvatarBehaviour aplica só quando move===0.
    idleTurnMultiplier = 1.5;
    private fabricator!: PrefabFabricator;
    private readonly tileWidth:number;
    private readonly tileHeight:number;
    //dimensões do mapa em células, preenchidas pelo mapSync — o server garante
    //mapSync antes de stateSync/spawn/snap, então os handlers de entidade podem
    //confiar que serverToWorld já tem o que precisa
    private mapW = 0;
    private mapH = 0;
    //o mapa do mapSync, célula a célula (categoria+tipo+extras) — guardado pra
    //predição local (MineAvatarBehaviour) checar colisão com a MESMA regra do
    //server (isFreeAtCells), em vez de andar cego e só descobrir a parede no
    //snap, e pra quem gera conteúdo local ler os extras da célula. undefined
    //até o mapSync chegar.
    private gameMap: GauntletMap | undefined;
    constructor(tileWidth:number, tileHeight:number){
        super();
        this.tileWidth = tileWidth;
        this.tileHeight = tileHeight;
    }
    start(): void {
        super.start();
        //eu tenho o world do node. Eu SEI que é um implementador de PrefabFabricator, mesmo que world não implemente isso.
        //não é o ideal mas por hora é como será
        this.fabricator = this.node.world as unknown as PrefabFabricator;
        //falha AQUI, legível, em vez de "undefined is not a function" no mapSync
        if (typeof this.fabricator?.fabricate !== "function") {
            throw new Error("GauntletNetwork: o World deste nó não implementa PrefabFabricator.");
        }
        //Não depende de mapSync (não precisa de mapW/mapH), então nasce aqui
        //em vez de esperar o primeiro pacote de rede.
        this.entitiesNode = new Node();
        this.entitiesNode.name = "Entities";
        this.node.addChild(this.entitiesNode);
        //A conexão NÃO começa aqui: o login HTTP é do form da UI
        //(GauntletLoginPanel), e o gatilho é a flag no redux — ver update().
    }

    //Chamado pela MineAvatarBehaviour a 20 Hz. turn/move são relativos à
    //orientação atual (giro e andar-na-direção-que-olha, não eixos de
    //mundo) — ver MineAvatarBehaviour.currentIntent. Ignorado silenciosamente
    //antes do wsGame abrir — não deveria acontecer (a behaviour só existe
    //depois do stateSync, que já implica socket aberto), mas closed/connecting
    //jogariam no send() e derrubariam o socket.
    //Devolve o seq usado (ou undefined se não deu pra enviar) pra o
    //MineAvatarBehaviour indexar o histórico de predição por seq — é o que a
    //reconciliação compara contra o ack do server.
    sendInput(turn: number, move: number): number | undefined {
        if (this.wsGame?.readyState !== WebSocket.OPEN) return undefined;
        const seq = this.inputSeq++;
        const payload = JSON.stringify({ operation: "input", seq, turn, move, protocolVersion: PROTOCOL_VERSION });
        //Passa pelo netSim: no dev com ?lag, atrasa o envio do input (client→
        //server) igual à latência real; sem o param, envia na hora. O seq é
        //alocado no enfileiramento (acima) pra manter a ordem dos inputs.
        netSim.schedule("up", () => {
            if (this.wsGame?.readyState === WebSocket.OPEN) this.wsGame.send(payload);
        });
        return seq;
    }

    /** O mapa da instância, ou undefined antes do mapSync. Quem gera conteúdo
     *  a partir da descrição das células (grama e cia.) lê daqui. */
    get map(): GauntletMap | undefined {
        return this.gameMap;
    }

    /** Delta em CÉLULAS (espaço do server/da predição) → delta em unidades-
     *  mundo. Mesma escala do serverToWorldX/Z, sem o offset de centralização
     *  (aqui é DIFERENÇA, não posição absoluta). Usado pelo dead reckoning de
     *  NetworkedEntityBehaviour.update(). */
    cellsToWorldDelta(dCellsX: number, dCellsZ: number): [number, number] {
        return [dCellsX * this.tileWidth, dCellsZ * this.tileHeight];
    }

    //Os ritos de entrada, depois do modal de personagem resolver (ver update()):
    //primeiro os parâmetros de movimento DESTE personagem (GET, só depois
    //disso resolver é que abre QUALQUER socket — ver openSignalingSocket),
    //depois signaling (join = reserva de vaga, carregando o character junto)
    //e, com o ok, o socket de jogo. Pressupõe sessão já autenticada — o
    //POST /login foi feito pela UI e o fetch/handshakes WS herdam o cookie.
    private connectSignaling(character: string): void {
        this.character = character;
        //credentials:"include" pro cookie de sessão viajar no cross-origin
        //(página em gauntlet.dongeronimo.net, backend em api.dongeronimo.net).
        //Em dev (backendBase "") é same-origin e "include" também manda o cookie.
        fetch(`${backendBase()}/api/player-controller-settings/${character}`, { credentials: "include" })
            .then(res => {
                if (!res.ok) throw new Error(`GET /api/player-controller-settings/${character}: HTTP ${res.status}`);
                return res.json() as Promise<PlayerControllerSettingsDto>;
            })
            .then(settings => {
                this.moveSpeedForward = settings.moveSpeedForward;
                this.moveSpeedBackward = settings.moveSpeedBackward;
                this.accel = settings.accel;
                this.angularVelocityDegPerSec = settings.angularVelocityDegPerSec;
                this.moveStateEpsilon = settings.moveStateEpsilon;
                this.playerRadius = settings.playerRadius;
                this.idleTurnMultiplier = settings.idleTurnMultiplier;
            })
            .catch(err => {
                //Sem isto o login travaria mudo se o fetch falhasse (connectionStarted
                //já virou true no update(), nunca mais tenta de novo). Loga alto e
                //segue com os defaults hardcoded acima em vez de travar o jogador.
                console.error("GauntletNetwork: falha buscando player-controller-settings, seguindo com os defaults", err);
            })
            .finally(() => this.openSignalingSocket());
    }

    //URL do WS. Em prod aponta pro backend DIRETO (backendBase = https://api...
    //→ wss://api...), fora do CloudFront. Em dev/local, backendBase é "" e cai
    //no host da página (proxy do Vite), derivando wss:// em https e ws:// em
    //http (página HTTPS bloqueia ws:// como mixed content).
    private wsUrl(path: string): string {
        const base = backendBase();
        if (base) return base.replace(/^http/, "ws") + path; //https→wss, http→ws
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${location.host}${path}`;
    }

    private openSignalingSocket(): void {
        this.wsSignaling = new WebSocket(this.wsUrl("/ws/signaling"));
        this.wsSignaling.onopen = ()=>this.wsSignaling.send(JSON.stringify(joinRequest(this.character)));
        this.wsSignaling.onmessage = e=> {
            const msg = JSON.parse(e.data);
            assertProtocol(msg); //explode se o server estiver num protocolo abaixo do nosso
            //Tive sucesso em dar join - já tem um slot em uma instância reservado pra mim,
            if(msg.operation === "join" && msg.result ==="ok") {
                this.connectGame();
            } else if (msg.operation === "join") {
                //"alreadyInGame"/"badCharacter" — não deveria acontecer no
                //fluxo normal (modal só oferece characters válidos); loga alto
                //em vez de deixar a conexão pendurada muda.
                console.error("GauntletNetwork: join recusado pelo server:", msg.result);
            }
        }
    }

    dispose(): void {
        if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
        this.wsGame?.close();
        this.wsSignaling?.close();
    }

    //Ping do medidor de lag (2 Hz, ver connectGame). Carimba t ANTES do netSim
    //(pra o RTT incluir a ida) e envia pelo mesmo caminho do input; o server
    //ecoa num pong e dispatch() mede. Passa pelo netSim, então o RTT reflete o
    //lag real/simulado.
    private sendPing(): void {
        if (this.wsGame?.readyState !== WebSocket.OPEN) return;
        const t = performance.now();
        netSim.schedule("up", () => {
            if (this.wsGame?.readyState === WebSocket.OPEN)
                this.wsGame.send(JSON.stringify({ operation: "ping", t, protocolVersion: PROTOCOL_VERSION }));
        });
    }

    private connectGame() {
        this.wsGame = new WebSocket(this.wsUrl("/ws/game"));
        //Sem onopen: nesta fase o client não manda NADA no /ws/game — o server
        //nos reconhece pelo cookie de sessão e fala primeiro (welcome).
        //O corpo do handler fica num arrow nomeado (dispatch) pra a entrega
        //passar pelo netSim (ver a linha de atribuição de onmessage no fim).
        const dispatch = (e: MessageEvent) => {
            const msg = JSON.parse(e.data) as GameServerMessage;
            assertProtocol(msg); //explode se o server estiver num protocolo abaixo do nosso
            if(msg.operation === "pong") {
                //medidor de lag: não é evento de mundo — mede o RTT e sai. Como
                //dispatch roda atrás do netSim(down), o RTT inclui o lag simulado.
                netStats.recordRtt(performance.now() - msg.t);
                return;
            }
            if(msg.operation === "welcome") {
                this.instanceData = new InstanceData(msg.id, msg.instanceId, msg.tickRate);
                //now that i have the instance data i'm officially in the instance
            }
            if(msg.operation === "mapSync") {
                // {"operation":"mapSync", "w":32, "h":32, "cells":[
                //   {"category":"wall","type":"basicWall"},
                //   {"category":"passable","type":"dirtGround","extras":{"grassSeed":"1f8f31c2"}}, ...]}
                // row-major, w*h células — ver GauntletMap
                try {
                    this.onMapSync(msg);
                }
                catch(e){
                    console.error("GauntletNetwork: erro no mapSync", e);
                }
            }
            if(msg.operation === "stateSync") {
                // foto completa de TUDO que existe, 1x na entrada (spawn é só o delta)
                this.onEntsAdded(msg.ents);
            }
            if(msg.operation === "spawn") {
                //delta: só os que chegaram DEPOIS de mim (veteranos recebem;
                //eu mesmo já vim no stateSync — onEntsAdded ignora reentrada
                //via entities.has)
                this.onEntsAdded(msg.ents);
            }
            if(msg.operation === "despawn") {
                for (const id of msg.ids) {
                    const behaviour = this.entities.get(id);
                    if (!behaviour) continue; //já não existia — nada a fazer
                    destroyInstance(behaviour.node); //roda dispose() das behaviours + destaca
                    this.entities.delete(id);
                }
            }
            if(msg.operation === "snap") {
                //fase 1b: sem rewind/replay de input — cada NetworkedEntityBehaviour
                //corrige por BLEND (pawn local: residual da predição própria;
                //remoto: residual do dead reckoning) e atualiza a velocidade
                //conhecida, que alimenta a extrapolação até o PRÓXIMO snap.
                for (const ent of msg.ents) {
                    const behaviour = this.entities.get(ent.id);
                    if (!behaviour) {
                        console.warn("GauntletNetwork: snap com id desconhecido, ignorando", ent.id);
                        continue;
                    }
                    behaviour.applySnap(ent.x, ent.z, ent.yaw, ent.vx, ent.vz, ent.state, ent.ack);
                }
            }
        };
        //Entrega do state pelo netSim: no dev normal e em produção roda na hora;
        //com ?lag=NNN na URL, atrasa o handling (server→client) simulando a nuvem.
        this.wsGame.onmessage = (e) => netSim.schedule("down", () => dispatch(e));
        //Medidor de lag: ping a 2 Hz enquanto o socket de jogo estiver vivo.
        this.pingTimer = window.setInterval(() => this.sendPing(), 500);
    }
    
    //Compartilhado por stateSync (foto completa) e spawn (delta): mesmo
    //EntityDto, mesma regra de criação. Idempotente via entities.has — o
    //stateSync do PRÓPRIO novato já traz o seu pawn, então quando (se algum
    //dia) o mesmo id aparecesse nos dois, a 2ª chamada é no-op.
    private onEntsAdded(ents: EntityDto[]): void {
        if (!this.instanceData) {
            //Não deveria acontecer — o protocolo garante welcome antes de
            //stateSync/spawn — mas falhar legível aqui é melhor que
            //"Cannot read properties of undefined" lá embaixo.
            console.error("GauntletNetwork: stateSync/spawn chegou antes do welcome");
            return;
        }
        for (const ent of ents) {
            if (this.entities.has(ent.id)) continue;
            if (ent.kind !== "player") continue; //só player existe por ora
            //CUIDADO: ent.owner é o id da CONTA dona do pawn; myId (do welcome)
            //é o id da ENTIDADE que sou eu. Comparar owner com myId (bug antigo
            //aqui) "funciona" por coincidência quando entityId==playerId no
            //teste com poucos players — mas é semanticamente errado. O jeito
            //certo é ENTIDADE-com-ENTIDADE.
            const isMine = ent.id === this.instanceData.myId;

            //PIVOT em vez de aplicar yaw direto no clone do armature: o
            //Armature (xbot/Mixamo) já vem do glb com uma rotação local
            //própria (a correção de eixo do import) — sobrescrever isso com
            //`eulerAngles = (0, yaw, 0)` era o que deixava o boneco deitado
            //(apagava a correção em vez de compor com ela). O pivot fica
            //neutro (só posição+yaw) e o armature-clone, filho dele, mantém
            //a rotação importada intacta; a composição de matrizes do
            //próprio Node cuida do resto.
            const pivot = new Node();
            pivot.name = isMine ? "MyAvatar" : `Avatar${ent.id}`;
            pivot.setParent(this.entitiesNode);
            vec3.set(this.serverToWorldX(ent.x), 0, this.serverToWorldZ(ent.z), pivot.position);
            pivot.eulerAngles = vec3.create(0, ent.yaw * RAD_TO_DEG, 0);

            //behaviour no PIVOT (não no skin): é o pivot que representa "a
            //entidade" (posição+yaw movem ele), e o skin embaixo dele fica
            //livre pra eventual lógica de animação futura sem competir por
            //quem é dono do transform. ent.character ("Dmitry"/"Nat") já É o
            //nome do prefab — mandado pelo server pra TODO client, não só o
            //dono, então Bob vê o MESMO personagem que a Alice escolheu.
            this.fabricator.fabricate([0, 0, 0], ent.character, pivot);

            //Luz fraca acima do player: cada avatar carrega sua própria
            //spotlight, apontada pra baixo, reforçando o char perto do chão
            //sem depender só da luz global (ver gauntletWorld.ts — agora um
            //DirectionalLight de verdade, que é quem ilumina/sombreia a
            //dungeon inteira). Filha do pivot: acompanha posição/yaw
            //automaticamente. Altura reduzida de 8 pra 2.5: 8 unidades acima
            //de um personagem de ~2 de altura é praticamente um lustre longe
            //dele — a ~90° do topo da cabeça, não "acima" no sentido visual
            //(um cone estreito lá de cima mal cobre o corpo). 2.5 deixa o
            //cone efetivamente pairando sobre o personagem. atten =
            //intensity/dist (linear, ver PhongColorMaterial) = 1.0/2.5 = 0.4,
            //bem mais fraco que o 12/8=1.5 de antes.
            const headLight = new Node();
            headLight.name = "PlayerLight";
            headLight.setParent(pivot);
            vec3.set(0, 6, 0, headLight.position);
            const spot = new SpotLight();
            spot.color = [1, 0.95, 0.85];
            spot.intensity = 2.0; //fraquinha de propósito
            spot.innerConeAngle = utils.degToRad(30);
            spot.outerConeAngle = utils.degToRad(60);
            headLight.light = spot;
            //aponta o -Z pra baixo (convenção do Camera/lookAt) — up não pode
            //ser (0,1,0) aqui: seria paralelo à direção e degenera o lookAt.
            const eye = headLight.getWorldMatrix();
            headLight.lookAt(vec3.create(eye[12], eye[13] - 1, eye[14]), vec3.create(0, 0, 1));

            //NetworkedEntityBehaviour: TODA entidade de rede tem (reconciliação
            //por snap + dead reckoning) — hoje só player, amanhã monstro/tesouro
            //igual. MineAvatarBehaviour é o extra só de QUEM SOU EU (input +
            //predição local); locallyPredicted=true desliga o dead reckoning
            //dela, que ficaria redundante com a predição.
            const entityBehaviour = new NetworkedEntityBehaviour(this, isMine);
            pivot.addBehaviour(entityBehaviour);
            if (isMine) {
                //o avatar local é dono da predição+histórico+reconciliação; o
                //NetworkedEntityBehaviour delega o snap do MEU pawn pra ele
                //(reconcile) em vez de dar o blend-rumo-ao-server dos remotos.
                const mine = new MineAvatarBehaviour(this);
                pivot.addBehaviour(mine);
                entityBehaviour.setLocalAvatar(mine);
            }
            this.entities.set(ent.id, entityBehaviour);

            if (isMine) {
                const cam = this.node.world!.findNode("Camera");
                //offset fixo atrás/acima do pivot; a behaviour persegue todo
                //frame — substitui o snap único de antes (só valia no spawn).
                cam?.addBehaviour(new CameraFollowBehaviour(pivot, vec3.create(7, 11, 7)));
            }
        }
    }

    //Constrói o mapa estático a partir das células do mapSync (cada uma se
    //descreve: categoria, tipo e extras). Ao final disso eu tenho o mapa
    //comum, igual pros 4 players.
    private onMapSync(msg: MapSyncMessage): void {
        this.mapW = msg.w;
        this.mapH = msg.h;
        this.gameMap = new GauntletMap(msg.w, msg.h, msg.cells);
        //tudo do mapa pendurado num nó só: debug no getAllNodes e teardown fáceis
        this.mapNode = new Node();
        this.mapNode.name = "Map";
        this.node.addChild(this.mapNode);
        //Container só da vegetação, irmão do resto do mapa: a grama é a coisa
        //que mais faz node aqui (dezenas por célula), e separar mantém o
        //getAllNodes legível e deixa "sumir com a grama" a um setParent(null).
        this.grassNode = new Node();
        this.grassNode.name = "Grass";
        this.mapNode.addChild(this.grassNode);
        this.gameMap.forEachCell((cell, x, z) => {
            //Só importam os espaços onde eu posso andar — pela CATEGORIA, não
            //pelo tipo: chão novo que este client não conhece continua sendo
            //chão. Não vou fazer node onde é irrelevante.
            if(cell.category !== "passable") return;
            //célula (x,z) → tile no CENTRO dela (x+0.5, z+0.5): mesh do
            //tile tem origem no centro (conferido no glb)
            this.fabricateFloor(cell, x, z);
            //A decoração vem DEPOIS do chão dela, e é local: nada disso viaja
            //node a node pela rede, tudo sai do que o server compactou no extra.
            this.fabricateGrass(cell, x, z);
            //Paredes: um painel por face aberta→fechada, plantado NA
            //aresta entre as duas células. O Wall00 corre ao longo de X
            //com base em y=0 (medido no glb): norte/sul saem na orientação
            //default, leste/oeste giram 90° em Y.
            this.fabricateWallIfSolid(x,     z - 1, x + 0.5, z,       false); //norte
            this.fabricateWallIfSolid(x,     z + 1, x + 0.5, z + 1,   false); //sul
            this.fabricateWallIfSolid(x - 1, z,     x,       z + 0.5, true);  //oeste
            this.fabricateWallIfSolid(x + 1, z,     x + 1,   z + 0.5, true);  //leste
        });
        //Uma linha, uma vez: enquanto o gerador estiver sendo escrito é o que
        //diz se o problema é o dado que chegou ou o algoritmo que o expande.
        console.log(`GauntletNetwork: grama em ${this.grassCells} células, ${this.grassBlades} tufos`);
    }

    //O chão de UMA célula. É aqui que a decoração local se pendura: a célula
    //inteira está em mãos, então o que o server compactou nos extras (ex.: a
    //seed que o gerador de grama expande em N tufos) se lê de cell.extras —
    //nada disso vem node a node pela rede.
    private fabricateFloor(cell: MapCellDto, x: number, z: number): void {
        const prefab = prefabForCellType(FLOOR_PREFAB_BY_TYPE, cell.type, FALLBACK_FLOOR_PREFAB);
        this.fabricator.fabricate(
            [this.serverToWorldX(x + 0.5), 0, this.serverToWorldZ(z + 0.5)],
            prefab, this.mapNode
        );
    }

    //A grama de UMA célula: o server mandou UM valor (extra grassSeed), o
    //gerador local expande em N tufos e aqui eles viram node. A divisão de
    //tarefas é essa: grass.ts decide ONDE (em coordenada de célula, 0..1), 
    //este método decide, pq quem sabe traduzir célula→mundo é esta classe, 
    //e ela é a única que sabe (serverToWorldX/Z). O gerador não vê tileWidth 
    //nem prefab.
    //Basicamente isso impede que vaze informação de posição global e de escolha
    //de prefabs pro generateGrassBlades que não tem pq saber nada disso.
    private fabricateGrass(cell: MapCellDto, x: number, z: number): void {
        const grass = decodeGrassSeed(cell.extras?.[MapExtras.GRASS_SEED]);
        if (grass === undefined) return; //célula sem grama: extra ausente
        const blades = generateGrassBlades(x, z, grass);
        if (blades.length === 0) return;
        //Truncagem defensiva: um gerador com bug (loop errado, densidade lida
        //como contagem) faria milhares de nodes SKINNED por célula e travaria a
        //aba antes de qualquer mensagem de erro aparecer. Melhor grama faltando
        //e um warn do que a página morta.
        const usados = Math.min(blades.length, GRASS_MAX_BLADES_PER_CELL);
        if (blades.length > usados && !this.warnedGrassOverflow) {
            this.warnedGrassOverflow = true; //uma vez, não uma por célula
            console.warn(`GauntletNetwork: gerador devolveu ${blades.length} tufos numa célula, ` +
                `truncando em ${GRASS_MAX_BLADES_PER_CELL} (ver GRASS_MAX_BLADES_PER_CELL)`);
        }
        for (let i = 0; i < usados; i++) {
            const blade = blades[i];
            //u/v são posição DENTRO da célula (0..1), então a coordenada de
            //célula é x+u — mesma conta do centro do tile (x+0.5), com o meio
            //trocado pelo que o gerador escolheu. y=0: o chão mora em y=0.
            const node = this.fabricator.fabricate(
                [this.serverToWorldX(x + blade.u), 0, this.serverToWorldZ(z + blade.v)],
                GRASS_PREFAB, this.grassNode
            );
            node.eulerAngles = vec3.create(0, blade.yaw, 0);
            vec3.set(blade.scale, blade.scale, blade.scale, node.scale);
        }
        this.grassCells++;
        this.grassBlades += usados;
    }

    //Levanta o painel se a célula VIZINHA (nx,nz) for parede — fora do grid
    //conta como parede (o gerador garante borda sólida; isto é o cinto de
    //segurança). Quem escolhe a arte é o tipo DA VIZINHA: é ela que está sendo
    //desenhada, não a célula de chão de onde estou olhando.
    //sx/sz em coordenadas de célula (a aresta fica em coordenada inteira, o
    //meio dela em .5); alongZ = parede correndo em Z (face leste/oeste).
    private fabricateWallIfSolid(nx: number, nz: number, sx: number, sz: number, alongZ: boolean): void {
        const neighbour = this.gameMap!.at(nx, nz);
        if(neighbour !== undefined && neighbour.category !== "wall") return;
        const prefab = neighbour === undefined
            ? FALLBACK_WALL_PREFAB //fora do mundo: não há célula pra consultar
            : prefabForCellType(WALL_PREFAB_BY_TYPE, neighbour.type, FALLBACK_WALL_PREFAB);
        const wall = this.fabricator.fabricate(
            [this.serverToWorldX(sx), 0, this.serverToWorldZ(sz)],
            prefab, this.mapNode
        );
        if(alongZ){
            wall.eulerAngles = vec3.create(0, 90, 0);
        }
    }

    //O server fala em CÉLULAS (1 célula = 1 unidade, origem no canto do mapa);
    //o mundo usa tile*célula com o mapa centrado na origem. TODA posição vinda
    //da rede — mapa E entidades (stateSync/spawn/snap trazem x,z em células,
    //ex.: 25.5 = centro da célula 25) — passa por estas duas funções. É UMA
    //transformação só; divergir aqui = pawn fora do mapa. Públicas: a
    //MineAvatarBehaviour usa o par completo (ida e volta) pra fazer a
    //colisão da predição local no MESMO espaço do server (células).
    serverToWorldX(sx: number): number {
        return this.tileWidth * sx - (this.mapW * this.tileWidth) / 2;
    }
    serverToWorldZ(sz: number): number {
        return this.tileHeight * sz - (this.mapH * this.tileHeight) / 2;
    }
    worldToCellX(wx: number): number {
        return (wx + (this.mapW * this.tileWidth) / 2) / this.tileWidth;
    }
    worldToCellZ(wz: number): number {
        return (wz + (this.mapH * this.tileHeight) / 2) / this.tileHeight;
    }

    //Fora do grid conta como parede — mesma regra da construção do mapa e do
    //GameMap.isWalkable do server. Antes do mapSync não há mundo: tudo sólido
    //(nenhuma predição pode andar num mapa que ainda não chegou).
    private isWalkableCell(cellX: number, cellZ: number): boolean {
        return this.gameMap?.isPassable(cellX, cellZ) ?? false;
    }

    /** 4 cantos do corpo em CÉLULAS — mesma checagem AABB×grid do server
     *  (GameLoop.isFree). Usada pela predição local (MineAvatarBehaviour)
     *  pra nunca prever um passo que o server rejeitaria. */
    isFreeAtCells(xCells: number, zCells: number): boolean {
        const r = this.playerRadius;
        return this.isWalkableCell(Math.floor(xCells - r), Math.floor(zCells - r))
            && this.isWalkableCell(Math.floor(xCells + r), Math.floor(zCells - r))
            && this.isWalkableCell(Math.floor(xCells - r), Math.floor(zCells + r))
            && this.isWalkableCell(Math.floor(xCells + r), Math.floor(zCells + r));
    }

    update(_deltaTime: number): void {
        //Gatilho da conexão (padrão getState-no-update da casa): a UI fez o
        //POST /login e flipou a flag; daqui pra frente a sessão está
        //autenticada. Duas etapas antes de abrir qualquer WS: 1) escolher
        //personagem (modal — GauntletCharacterSelectPanel.tsx despacha
        //gauntletCharacterChosen quando o player clica), 2) só então
        //connectSignaling, que já sabe qual character buscar/mandar.
        if(!this.connectionStarted && store.getState().gauntlet.loggedIn){
            const gauntlet = store.getState().gauntlet;
            if(gauntlet.character !== null){
                this.connectionStarted = true;
                this.connectSignaling(gauntlet.character);
            } else if(!gauntlet.choosingCharacter){
                store.dispatch(gauntletShowCharacterSelectionScreen());
            }
        }
        //Dead reckoning dos remotos e correção de resíduo do pawn local agora
        //rodam dentro de cada NetworkedEntityBehaviour (World.update já visita
        //todas as behaviours da árvore); nada a fazer aqui.
    }

}