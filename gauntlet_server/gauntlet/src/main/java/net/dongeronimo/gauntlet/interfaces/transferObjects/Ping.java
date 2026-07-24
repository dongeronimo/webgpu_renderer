package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Ping do medidor de lag do client: carrega o timestamp DELE (performance.now(),
 * ms). O server só ecoa de volta num pong com o mesmo t — não usa relógio
 * próprio, então não precisa de clock sincronizado; o client faz RTT = agora-t.
 * Não toca no mundo: o GameWS responde direto na IO thread (pelo decorator).
 */
public record Ping(double t) implements ClientMessage {}
