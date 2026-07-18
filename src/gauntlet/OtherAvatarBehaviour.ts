import { Behaviour } from "../behaviour";

/**
 * Anexada nos pawns dos OUTROS players (não o seu). Hoje é só um marcador
 * vazio: quem aplica posição/yaw a cada snap é a própria GauntletNetworkBehaviour
 * (snap cru, sem interpolação — fase 1). O motivo de já existir separada da
 * MineAvatarBehaviour: é aqui que futuramente entra a lógica de animação —
 * comparar snaps consecutivos pra decidir idle/andando e disparar o clip.
 */
export default class OtherAvatarBehaviour extends Behaviour {
    update(_deltaTime: number): void {}
}
