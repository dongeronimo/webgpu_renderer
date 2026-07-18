package net.dongeronimo.gauntlet.entities;

import org.springframework.web.socket.WebSocketSession;

/**
 * Eventos de membership que as threads de IO ENFILEIRAM na instância; só a
 * game thread drena e aplica (single-writer). É por essa fila que "entrou/
 * saiu alguém" chega no mundo sem nenhuma outra thread tocar no estado.
 */
public sealed interface InstanceEvent {
    /**
     * Socket de jogo conectou: o player passa a EXISTIR no mundo no tick que
     * processar isto. A sessão já vem decorada (ConcurrentWebSocketSessionDecorator)
     *  a game thread nunca vê a sessão crua.
     */
    record PlayerArrived(Player player, WebSocketSession session) implements InstanceEvent {}

    /** Qualquer uma das 3 portas de leave (leave explícito, close de qualquer socket). */
    record PlayerLeft(Player player) implements InstanceEvent {}

    /**
     * Intenção de movimento a 20 Hz. dx/dz chegam crus do client — quem
     * resolve playerId→pawn e guarda como intenção CORRENTE é a game thread
     * (Instance.intents), não este evento: ele só atravessa a fila.
     */
    record PlayerInput(Player player, double dx, double dz, long seq) implements InstanceEvent {}
}
