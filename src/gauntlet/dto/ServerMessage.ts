//Espelho do ServerMessage.java (sealed interface) — o shape de tudo que
///ws/game manda. União discriminada por "operation": um "if(msg.operation
//=== 'stateSync')" já estreita msg pra StateSyncMessage sozinho, sem cast —
//e um campo/typo errado (tipo o "ents.array" de antes) vira erro de
//compilação em vez de TypeError em runtime.
export interface EntityDto {
    id: number;
    kind: string;
    //"Dmitry"/"Nat" — nome do prefab a instanciar (ver GauntletNetwork.onEntsAdded
    //e gauntletWorld.ts), escolhido no modal pós-login e ecoado pelo server
    //pra TODO client, não só o dono (é isso que resolve Bob ver o Dmitry da Alice).
    character: string;
    owner: number;
    x: number;
    z: number;
    yaw: number;
    //nome do state de animação ("idle"/"walk"...) — opcional até o server
    //passar a mandar (ver GAUNTLET_MULTIPLAYER_NOTES.md); ausente = sem
    //troca de clip (NetworkedEntityBehaviour.applySnap fica no estado atual).
    state?: string;
}

export interface SnapEntity {
    id: number;
    x: number;
    z: number;
    yaw: number;
    //cells/s, espaço do server — pro dead reckoning entre snaps (ver
    //NetworkedEntityBehaviour.update()). Vem de GameLoop.stepMovement.
    vx: number;
    vz: number;
    state?: string;
    //último seq de input processado deste pawn — o DONO usa pra reconciliar
    //(compara a posição do server com a própria predição NAQUELE seq); os
    //outros ignoram. Ver MineAvatarBehaviour.reconcile.
    ack: number;
}

export interface WelcomeMessage {
    operation: "welcome";
    id: number;
    instanceId: number;
    tickRate: number;
    tick: number;
}

//Espelho de CellCategory.java. É o que TODO sistema (colisão, predição local,
//futuro pathfinding) lê pra decidir se dá pra andar — nunca o tipo. Assim tipo
//novo vindo de um server mais novo continua colidindo certo neste client.
export type CellCategory = "wall" | "passable";

//Espelho de MapCellDto.java. Sem x/z: a lista do mapSync é row-major, o índice
//JÁ é a posição (i = z*w + x) — ver GauntletMap.
export interface MapCellDto {
    category: CellCategory;
    //"basicWall"/"dirtGround" (espelho de CellType.java) — é o tipo que decide
    //qual prefab instanciar. Fica string (não união fechada) de propósito:
    //tipo desconhecido cai no fallback do client em vez de virar erro de
    //compilação toda vez que o server ganha uma variação nova.
    type: string;
    //kv livre da célula: o que não merece virar tipo. É por aqui que o server
    //manda, por exemplo, a SEED que o gerador de grama do client expande em N
    //tufos localmente, em vez de mandar um node por tufo. Ausente = vazio (o
    //server omite extras vazio pra não engordar ~1000 células).
    extras?: Record<string, string>;
}

export interface MapSyncMessage {
    operation: "mapSync";
    w: number;
    h: number;
    //w*h células, row-major (cells[z*w + x])
    cells: MapCellDto[];
}

export interface StateSyncMessage {
    operation: "stateSync";
    ents: EntityDto[];
}

export interface SpawnMessage {
    operation: "spawn";
    ents: EntityDto[];
}

export interface DespawnMessage {
    operation: "despawn";
    ids: number[];
}

export interface SnapMessage {
    operation: "snap";
    tick: number;
    ents: SnapEntity[];
}

//resposta ao ping do medidor de lag (ver GauntletNetwork.sendPing / netStats):
//o server ecoa o t que o client mandou; RTT = performance.now() - t.
export interface PongMessage {
    operation: "pong";
    t: number;
}

//só as mensagens do /ws/game — o /ws/signaling (JoinResponse) é outro canal,
//outro contrato.
export type GameServerMessage =
    | WelcomeMessage
    | MapSyncMessage
    | StateSyncMessage
    | SpawnMessage
    | DespawnMessage
    | SnapMessage
    | PongMessage;
