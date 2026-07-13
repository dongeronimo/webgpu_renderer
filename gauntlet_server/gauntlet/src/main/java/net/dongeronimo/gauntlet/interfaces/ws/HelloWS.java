package net.dongeronimo.gauntlet.interfaces.ws;

import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
/**
 * - Mensagens de io de uma mesma WebSocketSession chegam em serie, mensagens de sessões
 * diferentes em paralelo (threads de io do tomcat).
 * - Ao contrário de rest a gente não tem configuração automática de endpoint de websocket,
 * tem que escrever um configurer (ver WsConfig)
 */
@Component
public class HelloWS extends TextWebSocketHandler {
    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        System.out.println("conectou: "+session.getId());
    }
    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) 
    throws Exception {
          session.sendMessage(new TextMessage("echo: " + message.getPayload()));
      }

      @Override
      public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
          System.out.println("desconectou: " + session.getId() + " " +status);
      }
}
