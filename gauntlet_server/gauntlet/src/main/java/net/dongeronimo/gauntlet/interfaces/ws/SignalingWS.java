package net.dongeronimo.gauntlet.interfaces.ws;

import java.security.Principal;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.interfaces.transferObjects.ClientMessage;
import net.dongeronimo.gauntlet.interfaces.transferObjects.JoinRequest;
import net.dongeronimo.gauntlet.interfaces.transferObjects.JoinResponse;
import net.dongeronimo.gauntlet.interfaces.transferObjects.ServerMessage;
import net.dongeronimo.gauntlet.persistence.PlayerPersistence;
import net.dongeronimo.gauntlet.services.InstanceService;
import net.dongeronimo.gauntlet.services.JoinResult;
import net.dongeronimo.gauntlet.services.MapGenerator;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/** 
 * tá em /ws/signaling 
 * */
@Component
public class SignalingWS extends TextWebSocketHandler {
    /**
     * A gente vai precisar buscas e manipular player, então player persistence é necessário
     */
    private PlayerPersistence playerPersistence;
    /**
     * O coisa do Jackson pra trabalhar c json.
     */
    private ObjectMapper objectMapper;
    /**
     * Manipularemos instances, então precisamos do service. As ops de instância operam num nivel
     * mais alto de abstração que as do persistence. Então é um service e não a persistence.
     */
    private InstanceService instanceService;

    public SignalingWS(PlayerPersistence playerPersistence, 
        ObjectMapper objMapper, MapGenerator mapGenerator,
        InstanceService instanceService) {
        this.playerPersistence = playerPersistence;
        this.objectMapper = objMapper;
        this.instanceService = instanceService;
    }
    /**    
     * Quando o player entra eu preciso amarrá-lo ao websocket session.
    */
    @Override
    public void afterConnectionEstablished(WebSocketSession session)  throws Exception{
        Principal principal = session.getPrincipal();
        //Se não for PLAYER barra.
        if(principal == null) { 
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        Player player = playerPersistence.findByName(principal.getName()).orElseThrow();
        session.getAttributes().put("player", player); //pra poder andar junto com a sessão.
        player.setWebsocketId(session.getId());
        playerPersistence.save(player);
        System.out.println("conectou: "+player.getName()+", sessionId:"+session.getId());
    }
    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) 
    throws Exception {
        // com quem estamos falando?
        Player currentPlayer = (Player) session.getAttributes().get("player");
        // o que ele falou?
        ClientMessage msg;
        try {
            msg = objectMapper.readValue(message.getPayload(), ClientMessage.class);
        }        
        catch (JacksonException e) {
            System.out.print(e);
            return;
        }
        
        if(msg instanceof JoinRequest) {
            ServerMessage resposta;
            if(session.getAttributes().get("instance") != null){
                //fast-path: ESTA sessão já deu join
                resposta = new JoinResponse("alreadyInGame", null);
            }else {
                //Entra em uma instance
                JoinResult result = instanceService.joinInstance(currentPlayer);
                if(result.ok()) {
                    session.getAttributes().put("instance", result.instance());
                    resposta = new JoinResponse("ok", result.instance().getId());
                }else {
                    //mesma CONTA já está em jogo por OUTRA sessão (2ª aba)
                    resposta = new JoinResponse("alreadyInGame", null);
                }
            }
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(resposta)));
        }
        //TODO: outras requests aqui

    }
    
    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Player currentPlayer = (Player) session.getAttributes().get("player");
        Instance playerInstance = (Instance) session.getAttributes().get("instance");
        if(currentPlayer == null) {
            //POLICY_VIOLATION cai aqui tb, e nesse caso n vai ter player
            System.out.println("Desconection devido a POLICY_VIOLATION");
        }
        else {
            currentPlayer.setWebsocketId(null);
            playerPersistence.save(currentPlayer);
            if(playerInstance != null) { //conectou no signaling mas nunca deu join
                instanceService.removeFromInstance(currentPlayer, playerInstance);
            }
            System.out.println("desconectou: "+currentPlayer.getName()+", sessionId:" + session.getId() + " " +status);
        }
    }
}
