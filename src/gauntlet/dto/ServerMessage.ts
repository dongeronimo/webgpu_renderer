//Espelho do ServerMessage.java (sealed interface) — o shape de tudo que
///ws/game manda. União discriminada por "operation": um "if(msg.operation
//=== 'stateSync')" já estreita msg pra StateSyncMessage sozinho, sem cast —
//e um campo/typo errado (tipo o "ents.array" de antes) vira erro de
//compilação em vez de TypeError em runtime.
export interface EntityDto {
    id: number;
    kind: string;
    owner: number;
    x: number;
    z: number;
    yaw: number;
}

export interface SnapEntity {
    id: number;
    x: number;
    z: number;
    yaw: number;
    //cells/s, espaço do server — pro dead reckoning entre snaps (ver
    //GauntletNetwork.lastVelocity/update()). Vem de GameLoop.stepMovement.
    vx: number;
    vz: number;
}

export interface WelcomeMessage {
    operation: "welcome";
    id: number;
    instanceId: number;
    tickRate: number;
    tick: number;
}

export interface MapSyncMessage {
    operation: "mapSync";
    w: number;
    h: number;
    rows: string[];
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

//só as mensagens do /ws/game — o /ws/signaling (JoinResponse) é outro canal,
//outro contrato.
export type GameServerMessage =
    | WelcomeMessage
    | MapSyncMessage
    | StateSyncMessage
    | SpawnMessage
    | DespawnMessage
    | SnapMessage;
