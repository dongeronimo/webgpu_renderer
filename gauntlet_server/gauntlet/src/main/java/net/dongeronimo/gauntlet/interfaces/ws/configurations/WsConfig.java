package net.dongeronimo.gauntlet.interfaces.ws.configurations;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import net.dongeronimo.gauntlet.interfaces.ws.HelloWS;
import net.dongeronimo.gauntlet.interfaces.ws.SignalingWS;

@Configuration
@EnableWebSocket
public class WsConfig implements WebSocketConfigurer {
    private final HelloWS helloWS;
    private final SignalingWS signalingWS;

    public WsConfig(HelloWS helloWS, SignalingWS signalingWS){
        this.helloWS = helloWS;
        this.signalingWS = signalingWS;
    }
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(helloWS, "/ws").setAllowedOrigins("*");
        registry.addHandler(signalingWS, "/ws/signaling").setAllowedOrigins("*");
    }
}
