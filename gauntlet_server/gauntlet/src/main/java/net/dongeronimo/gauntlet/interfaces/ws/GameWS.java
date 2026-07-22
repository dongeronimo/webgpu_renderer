package net.dongeronimo.gauntlet.interfaces.ws;

import java.security.Principal;
import java.util.Optional;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.InstanceEvent;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.interfaces.transferObjects.ClientMessage;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Input;
import net.dongeronimo.gauntlet.persistence.PlayerPersistence;
import net.dongeronimo.gauntlet.services.InstanceService;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * O socket de JOGO (/ws/game): por ele saem welcome/mapSync/stateSync/snap e
 * (no 1a) entram input/ping. Este handler NÃO toca no mundo: a conexão vira
 * PlayerArrived na fila da instância e quem responde é a GAME thread no
 * próximo tick — é isso que garante welcome→mapSync→stateSync como um corte
 * consistente do mundo (e custa no máximo 50 ms de espera, irrelevante).
 */
@Component
public class GameWS extends TextWebSocketHandler {
    /**
     * Limites do decorator: send que estourar tempo ou buffer derruba a sessão
     * em vez de segurar a game thread — client lento não pode atrasar o tick
     * dos outros.
     */
    private static final int SEND_TIME_LIMIT_MS = 1000;
    private static final int SEND_BUFFER_SIZE_BYTES = 512 * 1024;

    private final PlayerPersistence playerPersistence;
    private final InstanceService instanceService;
    private final ObjectMapper objectMapper;

    public GameWS(PlayerPersistence playerPersistence, InstanceService instanceService,
        ObjectMapper objectMapper) {
        this.playerPersistence = playerPersistence;
        this.instanceService = instanceService;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        Principal principal = session.getPrincipal();
        if (principal == null) {
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        Player player = playerPersistence.findByName(principal.getName()).orElseThrow();
        //Correlaciona pelo Principal: o join no signaling já reservou a vaga,
        //o client não declara instância nenhuma, o server já sabe.
        Optional<Instance> instance = instanceService.findInstanceOf(player);
        if (instance.isEmpty()) {
            //Socket de jogo SEM reserva prévia = fecha na cara (mesma classe do 403).
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        session.getAttributes().put("player", player);
        session.getAttributes().put("instance", instance.get());
        //Daqui em diante quem escreve nessa sessão é a game thread; ela só
        //enxerga a sessão já embrulhada no decorator.
        WebSocketSession decorated = new ConcurrentWebSocketSessionDecorator(
            session, SEND_TIME_LIMIT_MS, SEND_BUFFER_SIZE_BYTES);
        instance.get().enqueue(new InstanceEvent.PlayerArrived(player, decorated));
        System.out.println("socket de jogo conectado: " + player.getName()
            + " → instância " + instance.get().getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
        throws Exception {
        //Mesmo padrão do SignalingWS: parse aqui, aplicação só na game thread.
        //IO thread NUNCA toca no mundo — só enfileira.
        ClientMessage msg;
        try {
            msg = objectMapper.readValue(message.getPayload(), ClientMessage.class);
        } catch (JacksonException e) {
            System.out.println("mensagem malformada no socket de jogo: " + e);
            return;
        }
        if (msg instanceof Input(long seq, double turn, double move)) {
            Player player = (Player) session.getAttributes().get("player");
            Instance instance = (Instance) session.getAttributes().get("instance");
            instance.enqueue(new InstanceEvent.PlayerInput(player, turn, move, seq));
        }
        //TODO: ping entra aqui também, no 1a ainda não fechado.
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Player player = (Player) session.getAttributes().get("player");
        Instance instance = (Instance) session.getAttributes().get("instance");
        if (player == null || instance == null) {
            return; //POLICY_VIOLATION: nunca chegou a entrar
        }
        //Uma das 3 portas do leave — o service é idempotente se o signaling
        //já tiver fechado antes.
        instanceService.removeFromInstance(player, instance);
        System.out.println("socket de jogo fechado: " + player.getName() + " " + status);
    }
}
