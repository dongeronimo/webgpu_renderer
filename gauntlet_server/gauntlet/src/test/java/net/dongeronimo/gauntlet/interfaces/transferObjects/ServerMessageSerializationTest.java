package net.dongeronimo.gauntlet.interfaces.transferObjects;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

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

    @Test
    void welcomeTemIdentidadeERelogio() {
        String json = mapper.writeValueAsString(new Welcome(7, 3, 20, 4000));
        System.out.println("welcome: " + json);
        assertTrue(json.contains("\"operation\":\"welcome\""));
        assertTrue(json.contains("\"id\":7"));
        assertTrue(json.contains("\"instanceId\":3"));
        assertTrue(json.contains("\"tickRate\":20"));
        assertTrue(json.contains("\"tick\":4000"));
    }

    @Test
    void mapSyncSaiLegivelNoDevTools() {
        String json = mapper.writeValueAsString(new MapSync(3, 2, List.of("###", "#.#")));
        System.out.println("mapSync: " + json);
        assertTrue(json.contains("\"operation\":\"mapSync\""));
        assertTrue(json.contains("\"w\":3"));
        assertTrue(json.contains("\"rows\":[\"###\",\"#.#\"]"));
    }

    @Test
    void spawnCarregaORetratoCompletoDaEntidade() {
        String json = mapper.writeValueAsString(
            new Spawn(List.of(new EntityDto(9, "player", 9, 0, 0, 0, "idle"))));
        System.out.println("spawn: " + json);
        assertTrue(json.contains("\"operation\":\"spawn\""));
        assertTrue(json.contains("\"kind\":\"player\""));
        assertTrue(json.contains("\"owner\":9"));
        assertTrue(json.contains("\"state\":\"idle\""));
    }

    @Test
    void snapCarregaSoOQueMudaA20Hz() {
        String json = mapper.writeValueAsString(
            new Snap(4021, List.of(new SnapEntity(9, 1.2, 3.4, 0.5, 1.0, -1.0, "walk"))));
        System.out.println("snap: " + json);
        assertTrue(json.contains("\"operation\":\"snap\""));
        assertTrue(json.contains("\"tick\":4021"));
        assertTrue(json.contains("\"id\":9"));
        assertTrue(json.contains("\"state\":\"walk\""));
        assertTrue(!json.contains("kind")); //shape enxuto: kind/owner já foram no spawn
    }
}
