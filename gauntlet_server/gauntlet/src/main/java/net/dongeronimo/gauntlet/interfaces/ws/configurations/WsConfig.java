package net.dongeronimo.gauntlet.interfaces.ws.configurations;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import net.dongeronimo.gauntlet.interfaces.ws.GameWS;
import net.dongeronimo.gauntlet.interfaces.ws.HelloWS;
import net.dongeronimo.gauntlet.interfaces.ws.SignalingWS;

@Configuration
@EnableWebSocket
public class WsConfig implements WebSocketConfigurer {
    //Origens permitidas no handshake do WS. Com a página em gauntlet.dongeronimo.net
    //e o WS em api.dongeronimo.net (etapa 1: WS direto na VM via Caddy, fora do
    //CloudFront), o handshake é cross-origin — o server valida a Origin aqui.
    //Prod = subdomínios do dongeronimo.net; dev = qualquer porta do localhost (o
    //proxy do Vite repassa a Origin real). PATTERNS (não setAllowedOrigins) pra
    //poder usar curinga.
    private static final String[] ALLOWED_ORIGINS = {
        "https://*.dongeronimo.net", "http://localhost:*"
    };

    private final HelloWS helloWS;
    private final SignalingWS signalingWS;
    private final GameWS gameWS;

    public WsConfig(HelloWS helloWS, SignalingWS signalingWS, GameWS gameWS){
        this.helloWS = helloWS;
        this.signalingWS = signalingWS;
        this.gameWS = gameWS;
    }
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(helloWS, "/ws").setAllowedOriginPatterns(ALLOWED_ORIGINS);
        registry.addHandler(signalingWS, "/ws/signaling").setAllowedOriginPatterns(ALLOWED_ORIGINS);
        registry.addHandler(gameWS, "/ws/game").setAllowedOriginPatterns(ALLOWED_ORIGINS);
    }
}
