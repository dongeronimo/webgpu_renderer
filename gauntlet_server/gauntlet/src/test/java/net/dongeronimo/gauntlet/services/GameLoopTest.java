package net.dongeronimo.gauntlet.services;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.InstanceEvent;
import net.dongeronimo.gauntlet.entities.Player;
import tools.jackson.databind.ObjectMapper;

/**
 * Ticka a instância NA MÃO (sem executor, sem server de pé): prova que a
 * chegada vira welcome→mapSync→stateSync NA ORDEM (a garantia da spec), que
 * os veteranos recebem spawn do novato, e que o leave vira despawn. As
 * sessões são mocks — só capturamos o que a game thread mandaria.
 */
public class GameLoopTest {
    //executor null de propósito: ninguém chama start/stop aqui, o tick é manual
    private final GameLoop loop = new GameLoop(new ObjectMapper(), null);
    private final MapGenerator generator = new MapGenerator();

    private Instance instancia() {
        Instance instance = new Instance(1);
        instance.setMap(generator.generate(42L));
        return instance;
    }

    private List<String> enviados(WebSocketSession session) throws Exception {
        ArgumentCaptor<TextMessage> captor = ArgumentCaptor.forClass(TextMessage.class);
        verify(session, atLeastOnce()).sendMessage(captor.capture());
        return captor.getAllValues().stream().map(TextMessage::getPayload).toList();
    }

    @Test
    void chegadaRecebeOsTresSyncsNaOrdemEDepoisSnap() throws Exception {
        Instance instance = instancia();
        Player alice = new Player(1, "Alice", "foobar");
        WebSocketSession session = mock(WebSocketSession.class);
        instance.enqueue(new InstanceEvent.PlayerArrived(alice, session));

        loop.tick(instance);

        List<String> msgs = enviados(session);
        assertEquals(4, msgs.size());
        assertTrue(msgs.get(0).contains("\"operation\":\"welcome\""), msgs.get(0));
        assertTrue(msgs.get(1).contains("\"operation\":\"mapSync\""), msgs.get(1));
        assertTrue(msgs.get(2).contains("\"operation\":\"stateSync\""), msgs.get(2));
        assertTrue(msgs.get(3).contains("\"operation\":\"snap\""), msgs.get(3));
        //welcome e o primeiro snap saem com o MESMO tick — o corte consistente
        assertTrue(msgs.get(0).contains("\"tick\":1"), msgs.get(0));
        assertTrue(msgs.get(3).contains("\"tick\":1"), msgs.get(3));
    }

    @Test
    void veteranoRecebeSpawnDoNovatoENovatoRecebeTodoMundoNoStateSync() throws Exception {
        Instance instance = instancia();
        Player alice = new Player(1, "Alice", "foobar");
        Player bob = new Player(2, "Bob", "lorenipsun");
        WebSocketSession sessaoAlice = mock(WebSocketSession.class);
        WebSocketSession sessaoBob = mock(WebSocketSession.class);

        instance.enqueue(new InstanceEvent.PlayerArrived(alice, sessaoAlice));
        loop.tick(instance);
        instance.enqueue(new InstanceEvent.PlayerArrived(bob, sessaoBob));
        loop.tick(instance);

        //tick 1: welcome/mapSync/stateSync/snap; tick 2: spawn do Bob + snap
        List<String> deAlice = enviados(sessaoAlice);
        assertEquals(6, deAlice.size());
        assertTrue(deAlice.get(4).contains("\"operation\":\"spawn\""), deAlice.get(4));
        assertTrue(deAlice.get(4).contains("\"owner\":2"), deAlice.get(4));

        //o stateSync do novato traz TUDO que está vivo, inclusive o pawn da Alice
        List<String> deBob = enviados(sessaoBob);
        assertTrue(deBob.get(2).contains("\"owner\":1"), deBob.get(2));
        assertTrue(deBob.get(2).contains("\"owner\":2"), deBob.get(2));
    }

    @Test
    void saidaViraDespawnProsQueFicam() throws Exception {
        Instance instance = instancia();
        Player alice = new Player(1, "Alice", "foobar");
        Player bob = new Player(2, "Bob", "lorenipsun");
        WebSocketSession sessaoAlice = mock(WebSocketSession.class);
        WebSocketSession sessaoBob = mock(WebSocketSession.class);
        instance.enqueue(new InstanceEvent.PlayerArrived(alice, sessaoAlice));
        instance.enqueue(new InstanceEvent.PlayerArrived(bob, sessaoBob));
        loop.tick(instance);

        instance.enqueue(new InstanceEvent.PlayerLeft(bob));
        loop.tick(instance);

        //tick 1 pra Alice: welcome/mapSync/stateSync/spawn(Bob)/snap = 5;
        //tick 2: despawn + snap = 7 no total
        List<String> deAlice = enviados(sessaoAlice);
        assertEquals(7, deAlice.size());
        assertTrue(deAlice.get(5).contains("\"operation\":\"despawn\""), deAlice.get(5));
        assertTrue(deAlice.get(5).contains("\"ids\":[2]"), deAlice.get(5)); //pawn do Bob = entidade 2
        //e o snap seguinte já não contém a entidade que despawnou
        assertFalse(deAlice.get(6).contains("\"id\":2"), deAlice.get(6));

        //Bob saiu ANTES do tick 2: não recebe nem o despawn dele nem o snap
        List<String> deBob = enviados(sessaoBob);
        assertEquals(4, deBob.size());
    }
}
