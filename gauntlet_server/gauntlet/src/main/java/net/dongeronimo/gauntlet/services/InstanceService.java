package net.dongeronimo.gauntlet.services;

import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.InstanceEvent;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.persistence.InstancePersistence;

@Service
public class InstanceService {
    private InstancePersistence instancePersistence;
    private MapGenerator mapGenerator;
    private GameLoop gameLoop;
    public InstanceService(InstancePersistence instancePersistence,
        MapGenerator mapGenerator, GameLoop gameLoop) {
        this.instancePersistence = instancePersistence;
        this.mapGenerator = mapGenerator;
        this.gameLoop = gameLoop;
    }

    /**
     * synchronized no método INTEIRO, não nos passos: find-or-create é operação
     * composta — o check (tem vaga?) e o act (cria/entra) precisam ser atômicos,
     * senão dois joins simultâneos criam duas instâncias ou lotam uma em 5/4.
     * Join é evento em frequência humana, o lock não contende.
     */
    public synchronized JoinResult joinInstance(Player player) {
        //Mesma CONTA em outra sessão (2ª aba): o attribute da sessão não pega
        //esse caso; o check autoritativo é aqui, DENTRO do lock, numa chamada
        //separada viraria check-then-act de novo.
        if(instancePersistence.findInstanceOf(player).isPresent()) {
            return new JoinResult(false, null);
        }
        List<Instance> instances = instancePersistence.getInstancesWithEmptySlots();
        Instance instance;
        if(instances.size() == 0){
            // Criar uma nova instância. O mundo nasce AQUI, uma vez por
            // instância — join de quem chega depois só entra no mundo que já existe.
            instance = instancePersistence.create();
            instance.setMap(mapGenerator.generate());
            // ...e o coração começa a bater junto com ele (tick de 50 ms).
            gameLoop.start(instance);
        }else {
            instance = instances.getFirst();
        }
        // Adiciona o player a essa instância
        instance.AddPlayer(player);
        return new JoinResult(true, instance);
    }

    /**
     * Leitura de membership sob o MESMO lock que a muda — é assim que o GameWS
     * correlaciona "conectou em /ws/game" com a vaga reservada no join.
     */
    public synchronized Optional<Instance> findInstanceOf(Player player) {
        return instancePersistence.findInstanceOf(player);
    }

    /**
     * Mesmo monitor do joinInstance (mesmo bean singleton): membership só muda sob um lock só.
     * Instance é TRANSIENTE — vive só na memória, a referência recebida É a ground truth.
     * Não há lookup nem update: quem persiste em banco é Player, nunca Instance.
     */
    public synchronized void removeFromInstance(Player player, Instance instance) {
        //Leave tem 3 portas (leave explícito, close do signaling, close do
        //socket de jogo) e pode bater 2× pro mesmo player — só a 1ª age.
        if(!instance.removePlayer(player)) {
            return;
        }
        //A game thread é quem tira o pawn do mundo e avisa os outros (despawn).
        instance.enqueue(new InstanceEvent.PlayerLeft(player));
        if(instance.getPlayerCount() == 0){
            gameLoop.stop(instance); //RUNNING→CLOSING→DEAD: cancela o tick
            instancePersistence.destroy(instance);
        }
    }
}
