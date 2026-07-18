package net.dongeronimo.gauntlet.persistence;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.Player;
@Service
public class InstancePersistence {
    // Serve pra ser um db fake
    private static List<Instance> gInstances;
    // uid fake (só sobe)
    private static long gCounter;
    
    public InstancePersistence(){
        if(gInstances == null){
            gInstances = new ArrayList<>();
            gCounter = 1;
        }
    }
    /** 
     *  Pode rolar duas criações de instance ao mesmo tempo. 
     *  Por enquanto eu enfileiro elas pra preservar integridade do gCounter, ele só
     *  alterado aqui.
     */
    public synchronized Instance create() {
        Instance i = new Instance(gCounter);
        gCounter = gCounter + 1;
        gInstances.add(i);
        return i;
    }

    public List<Instance> getInstancesWithEmptySlots(){
        //Join só seleciona RUNNING: instância CLOSING/DEAD não recebe ninguém.
        return gInstances.stream()
            .filter(instance -> instance.getState() == Instance.State.RUNNING
                && instance.getPlayerCount() < 4)
            .toList();
    }

    /**
     * Em qual instância (se alguma) esse player já está. Compara por referência
     * mesmo — o PlayerPersistence devolve sempre o mesmo objeto.
     */
    public Optional<Instance> findInstanceOf(Player player) {
        return gInstances.stream()
        .filter(i->i.getPlayers() != null && i.getPlayers().contains(player))
        .findFirst();
    }
    public void destroy(Instance instance) {
        gInstances.remove(instance);
    }
}
