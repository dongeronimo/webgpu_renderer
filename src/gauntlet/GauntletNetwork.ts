import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour"
import PrefabFabricator from "../PrefabFabricator";
import { JoinRequest } from "./dto/JoinMessage";
import { Node } from "../node";
import { store } from "../redux/store";
import type { EntityDto, GameServerMessage, MapSyncMessage } from "./dto/ServerMessage";
import { destroyInstance } from "../prefab";
import MineAvatarBehaviour from "./MineAvatarBehaviour";
import OtherAvatarBehaviour from "./OtherAvatarBehaviour";
import CameraFollowBehaviour from "./CameraFollowBehaviour";

//yaw chega do server em RADIANOS (Math.atan2 java); node.eulerAngles do
//client quer GRAUS (ver node.ts, quat.fromEuler) — a conversão mora aqui,
//não do lado do server, que não devia saber nada de convenção de client.
const RAD_TO_DEG = 180 / Math.PI;

//Fração do erro (predição local ou dead reckoning dos remotos) corrigida a
//CADA snap (20 Hz), em vez de teleportar pro valor do server. Sem
//rewind/replay de input — um puxão pequeno a cada 50ms é imperceptível.
const SNAP_BLEND = 0.35;

//lerp de ângulo em GRAUS pelo caminho mais curto — evita girar 350° quando
//o alvo tá a 10° de distância do outro lado da costura -180/180.
function lerpAngleDeg(fromDeg: number, toDeg: number, t: number): number {
    const delta = (((toDeg - fromDeg + 180) % 360 + 360) % 360) - 180;
    return fromDeg + delta * t;
}

//Mesmo raio do server (GameLoop.PLAYER_RADIUS) — TEM que bater, senão a
//predição local anda por onde o server nunca deixaria, e o pawn "afunda"
//visualmente na parede até o próximo snap corrigir (o tremor rápido que
//isto existe pra evitar).
const PLAYER_RADIUS_CELLS = 0.3;

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
    private entities = new Map<number, Node>();
    private mapNode!: Node;
    //container irmão do Map: pawns de player, separado pra não confundir
    //teardown de mapa (estático, nunca destrói) com teardown de entidade
    //(despawn destrói o node individual)
    private entitiesNode!: Node;
    //seq do input, sobe 1 por envio (20 Hz); server ignora na fase 1, mas
    //viaja desde já (pré-requisito da prediction da fase 2)
    private inputSeq = 0;
    // Will be defined after i get the welcome response, so we can check it to test if we are fully in the instance
    private instanceData: InstanceData|undefined = undefined;
    //Os ritos de conexão já foram disparados? (o update roda todo frame e a
    //flag do redux fica true pra sempre — sem isto seria um socket por frame)
    private connectionStarted = false;
    private fabricator!: PrefabFabricator;
    private readonly tileWidth:number;
    private readonly tileHeight:number;
    //dimensões do mapa em células, preenchidas pelo mapSync — o server garante
    //mapSync antes de stateSync/spawn/snap, então os handlers de entidade podem
    //confiar que serverToWorld já tem o que precisa
    private mapW = 0;
    private mapH = 0;
    //linhas cruas do mapSync ('#'=parede) — guardadas pra predição local
    //(MineAvatarBehaviour) checar colisão com a MESMA regra do server
    //(isFreeAtCells), em vez de andar cego e só descobrir a parede no snap.
    private mapRows: string[] = [];
    //última vx,vz conhecida por entidade (CÉLULAS/s, espaço do server) — pro
    //dead reckoning dos REMOTOS entre snaps. O pawn local NÃO usa isto pra se
    //mover (quem prediz ele é a própria MineAvatarBehaviour, a partir do
    //input); só guardamos aqui por uniformidade do snap handler.
    private lastVelocity = new Map<number, { vx: number; vz: number }>();
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

    //Chamado pela MineAvatarBehaviour a 20 Hz. Ignorado silenciosamente
    //antes do wsGame abrir — não deveria acontecer (a behaviour só existe
    //depois do stateSync, que já implica socket aberto), mas closed/connecting
    //jogariam no send() e derrubariam o socket.
    sendInput(dx: number, dz: number): void {
        if (this.wsGame?.readyState !== WebSocket.OPEN) return;
        this.wsGame.send(JSON.stringify({ operation: "input", seq: this.inputSeq++, dx, dz }));
    }

    /** Delta em CÉLULAS (espaço do server/da predição) → delta em unidades-
     *  mundo. Mesma escala do serverToWorldX/Z, sem o offset de centralização
     *  (aqui é DIFERENÇA, não posição absoluta). Usado pela MineAvatarBehaviour
     *  (predição local) e pelo dead reckoning dos remotos, em update(). */
    cellsToWorldDelta(dCellsX: number, dCellsZ: number): [number, number] {
        return [dCellsX * this.tileWidth, dCellsZ * this.tileHeight];
    }

    //Os ritos de entrada: signaling (join = reserva de vaga) e, com o ok, o
    //socket de jogo. Pressupõe sessão já autenticada — o POST /login foi
    //feito pela UI e os handshakes WS herdam o cookie.
    private connectSignaling(): void {
        this.wsSignaling = new WebSocket(`ws://${location.host}/ws/signaling`);
        this.wsSignaling.onopen = ()=>this.wsSignaling.send(JSON.stringify(JoinRequest));
        this.wsSignaling.onmessage = e=> {
            const msg = JSON.parse(e.data);
            //Tive sucesso em dar join - já tem um slot em uma instância reservado pra mim,
            if(msg.operation === "join" && msg.result ==="ok") {
                this.connectGame();
            }
        }
    }
    
    dispose(): void {
        this.wsGame?.close();
        this.wsSignaling?.close();
    }

    private connectGame() {
        this.wsGame = new WebSocket(`ws://${location.host}/ws/game`);
        //Sem onopen: nesta fase o client não manda NADA no /ws/game — o server
        //nos reconhece pelo cookie de sessão e fala primeiro (welcome).
        this.wsGame.onmessage = (e)=>{
            const msg = JSON.parse(e.data) as GameServerMessage;
            if(msg.operation === "welcome") {
                this.instanceData = new InstanceData(msg.id, msg.instanceId, msg.tickRate);
                //now that i have the instance data i'm officially in the instance
            }
            if(msg.operation === "mapSync") {
                // {"operation":"mapSync",  "w":52, "h":30, "rows":["#####...", "#...#..."]}
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
                    const node = this.entities.get(id);
                    if (!node) continue; //já não existia — nada a fazer
                    destroyInstance(node); //roda dispose() das behaviours + destaca
                    this.entities.delete(id);
                }
            }
            if(msg.operation === "snap") {
                //fase 1b: sem rewind/replay de input — corrige por BLEND. O
                //pawn local já foi movido pela predição da MineAvatarBehaviour
                //(pode ter divergido um pouco); os remotos já foram
                //extrapolados por dead reckoning em update() (ver lastVelocity).
                //Aqui a gente puxa uma FRAÇÃO do erro pra verdade do server e
                //atualiza a velocidade conhecida — pros remotos, é o que
                //alimenta a extrapolação até o PRÓXIMO snap.
                for (const ent of msg.ents) {
                    const node = this.entities.get(ent.id);
                    if (!node) {
                        console.warn("GauntletNetwork: snap com id desconhecido, ignorando", ent.id);
                        continue;
                    }
                    const targetX = this.serverToWorldX(ent.x);
                    const targetZ = this.serverToWorldZ(ent.z);
                    node.position[0] += (targetX - node.position[0]) * SNAP_BLEND;
                    node.position[2] += (targetZ - node.position[2]) * SNAP_BLEND;
                    const targetYawDeg = ent.yaw * RAD_TO_DEG;
                    node.eulerAngles = vec3.create(0, lerpAngleDeg(node.eulerAngles[1], targetYawDeg, SNAP_BLEND), 0);
                    this.lastVelocity.set(ent.id, { vx: ent.vx, vz: ent.vz });
                }
            }
        } 
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
            //livre pra eventual lógica de animação futura (OtherAvatarBehaviour)
            //sem competir por quem é dono do transform.
            this.fabricator.fabricate([0, 0, 0], isMine ? "alice" : "bob", pivot);
            pivot.addBehaviour(isMine ? new MineAvatarBehaviour(this) : new OtherAvatarBehaviour());
            this.entities.set(ent.id, pivot);

            if (isMine) {
                const cam = this.node.world!.findNode("Camera");
                //offset fixo atrás/acima do pivot; a behaviour persegue todo
                //frame — substitui o snap único de antes (só valia no spawn).
                cam?.addBehaviour(new CameraFollowBehaviour(pivot, vec3.create(0, 10, 6)));
            }
        }
    }

    //Constrói o mapa estático a partir da matriz de ocupação (rows[z][x], o
    //server gerou). Ao final disso eu tenho o mapa comum, igual pros 4 players.
    private onMapSync(msg: MapSyncMessage): void {
        this.mapW = msg.w;
        this.mapH = msg.h;
        this.mapRows = msg.rows;
        //tudo do mapa pendurado num nó só: debug no getAllNodes e teardown fáceis
        this.mapNode = new Node();
        this.mapNode.name = "Map";
        this.node.addChild(this.mapNode);
        for(let i=0; i<msg.h; i++) {
            for(let j=0; j<msg.w; j++){
                const currentValue = msg.rows[i][j];
                //Só importam os espaços onde eu posso andar ('.' e 'E' = exit).
                //Não vou fazer node onde é irrelevante.
                if(currentValue === '#') continue;
                //célula (j,i) → tile no CENTRO dela (j+0.5, i+0.5): mesh do
                //tile tem origem no centro (conferido no glb)
                this.fabricator.fabricate(
                    [this.serverToWorldX(j + 0.5), 0, this.serverToWorldZ(i + 0.5)],
                    "Floor00", this.mapNode
                );
                //Paredes: um painel por face aberta→fechada, plantado NA
                //aresta entre as duas células. O Wall00 corre ao longo de X
                //com base em y=0 (medido no glb): norte/sul saem na orientação
                //default, leste/oeste giram 90° em Y.
                if(this.isWall(msg.rows, j, i - 1)) this.fabricateWall(j + 0.5, i,     false, this.mapNode); //norte
                if(this.isWall(msg.rows, j, i + 1)) this.fabricateWall(j + 0.5, i + 1, false, this.mapNode); //sul
                if(this.isWall(msg.rows, j - 1, i)) this.fabricateWall(j,     i + 0.5, true,  this.mapNode); //oeste
                if(this.isWall(msg.rows, j + 1, i)) this.fabricateWall(j + 1, i + 0.5, true,  this.mapNode); //leste
            }
        }
    }

    //Fora do grid conta como parede: o gerador garante borda sólida, isto é
    //só cinto de segurança pro rows[z][x] não estourar.
    private isWall(rows: string[], x: number, z: number): boolean {
        if(z < 0 || z >= rows.length) return true;
        const row = rows[z];
        if(x < 0 || x >= row.length) return true;
        return row[x] === '#';
    }

    //sx/sz em coordenadas de célula (a aresta fica em coordenada inteira,
    //o meio dela em .5); alongZ = parede correndo em Z (face leste/oeste)
    private fabricateWall(sx: number, sz: number, alongZ: boolean, parent: Node): void {
        const wall = this.fabricator.fabricate(
            [this.serverToWorldX(sx), 0, this.serverToWorldZ(sz)],
            "Wall00", parent
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

    //Fora do grid conta como parede — mesma regra do isWall (construção do
    //mapa) e do GameMap.isWalkable do server.
    private isWalkableCell(cellX: number, cellZ: number): boolean {
        if (cellZ < 0 || cellZ >= this.mapRows.length) return false;
        const row = this.mapRows[cellZ];
        if (cellX < 0 || cellX >= row.length) return false;
        return row[cellX] !== '#';
    }

    /** 4 cantos do corpo em CÉLULAS — mesma checagem AABB×grid do server
     *  (GameLoop.isFree). Usada pela predição local (MineAvatarBehaviour)
     *  pra nunca prever um passo que o server rejeitaria. */
    isFreeAtCells(xCells: number, zCells: number): boolean {
        const r = PLAYER_RADIUS_CELLS;
        return this.isWalkableCell(Math.floor(xCells - r), Math.floor(zCells - r))
            && this.isWalkableCell(Math.floor(xCells + r), Math.floor(zCells - r))
            && this.isWalkableCell(Math.floor(xCells - r), Math.floor(zCells + r))
            && this.isWalkableCell(Math.floor(xCells + r), Math.floor(zCells + r));
    }

    update(deltaTime: number): void {
        //Gatilho da conexão (padrão getState-no-update da casa): a UI fez o
        //POST /login e flipou a flag; daqui pra frente a sessão está
        //autenticada e dá pra abrir os WS.
        if(!this.connectionStarted && store.getState().gauntlet.loggedIn){
            this.connectionStarted = true;
            this.connectSignaling();
        }
        //Dead reckoning dos REMOTOS: entre snaps (50ms a 20Hz), extrapola pela
        //última velocidade conhecida — sem isso o movimento deles só "pula" a
        //cada snap. O pawn local FICA DE FORA (id === myId): quem já move ele
        //todo frame é a MineAvatarBehaviour, a partir do input de verdade.
        const myId = this.instanceData?.myId;
        for (const [id, node] of this.entities) {
            if (id === myId) continue;
            const vel = this.lastVelocity.get(id);
            if (!vel) continue; //ainda não chegou nenhum snap pra essa entidade
            const [dx, dz] = this.cellsToWorldDelta(vel.vx * deltaTime, vel.vz * deltaTime);
            node.position[0] += dx;
            node.position[2] += dz;
        }
    }

}