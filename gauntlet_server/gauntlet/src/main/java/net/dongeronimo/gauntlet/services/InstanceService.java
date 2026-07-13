package net.dongeronimo.gauntlet.services;

import java.util.List;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.persistence.InstancePersistence;

@Service
public class InstanceService {
    private InstancePersistence instancePersistence;
    public InstanceService(InstancePersistence instancePersistence) {
        this.instancePersistence = instancePersistence; 
    }

    /**
     * synchronized no método INTEIRO, não nos passos: find-or-create é operação
     * composta — o check (tem vaga?) e o act (cria/entra) precisam ser atômicos,
     * senão dois joins simultâneos criam duas instâncias ou lotam uma em 5/4.
     * Join é evento em frequência humana, o lock não contende.
     */
    public synchronized JoinResult joinInstance(Player player) {
        //Mesma CONTA em outra sessão (2ª aba): o attribute da sessão não pega
        //esse caso; o check autoritativo é aqui, DENTRO do lock — numa chamada
        //separada viraria check-then-act de novo.
        if(instancePersistence.findInstanceOf(player).isPresent()) {
            return new JoinResult(false, null);
        }
        List<Instance> instances = instancePersistence.getInstancesWithEmptySlots();
        Instance instance;
        if(instances.size() == 0){
            // Criar uma nova instância
            instance = instancePersistence.create();
            //TODO: Cria o mundo inicial da instance: gera o mapa aleatorio
        }else {
            instance = instances.getFirst();
        }
        // Adiciona o player a essa instância
        instance.AddPlayer(player);
        return new JoinResult(true, instance);
    }

    /** Mesmo monitor do joinInstance (mesmo bean singleton): membership só muda sob um lock só. */
    public synchronized void removeFromInstance(Player player, Instance instance) {
        //TODO: tirar o player
        //TODO: se a instância ficou vazia, deleta ela
    }
}
