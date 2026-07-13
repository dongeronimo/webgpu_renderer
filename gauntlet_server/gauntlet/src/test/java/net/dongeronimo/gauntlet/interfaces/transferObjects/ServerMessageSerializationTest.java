package net.dongeronimo.gauntlet.interfaces.transferObjects;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.ObjectMapper;

/**
 * Prova o lado da ESCRITA do protocolo sem subir o server: o "operation" tem
 * que sair sozinho no JSON, vindo do nome registrado no JsonSubTypes — as
 * classes não têm esse campo.
 */
public class ServerMessageSerializationTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void joinOk() {
        String json = mapper.writeValueAsString(new JoinResponse("ok", 1L));
        System.out.println("joinOk: " + json);
        assertTrue(json.contains("\"operation\":\"join\""));
        assertTrue(json.contains("\"result\":\"ok\""));
        assertTrue(json.contains("\"instanceId\":1"));
    }

    @Test
    void joinRecusado() {
        String json = mapper.writeValueAsString(new JoinResponse("alreadyInGame", null));
        System.out.println("joinRecusado: " + json);
        assertTrue(json.contains("\"operation\":\"join\""));
        assertTrue(json.contains("\"result\":\"alreadyInGame\""));
        assertTrue(json.contains("\"instanceId\":null"));
    }
}
