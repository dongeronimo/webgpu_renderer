package net.dongeronimo.gauntlet.persistence;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.Player;

@Service
public class PlayerPersistence {
    // fake de db. enquanto eu não botar o sql vai ser o que eu vou usar
    private static List<Player> players;

    public PlayerPersistence() {
        if(players == null) {
            players = new ArrayList<>();
            players.add(new Player(1, "Alice", 
            "{noop}foobar"));
            players.add(new Player(2, "Bob", 
            "{noop}lorenipsun"));
        }    
    }

    public Optional<Player> findByName(String name) {
        return players.stream()
        .filter(p->p.getName().equals(name))
        .findFirst();
    }

    public void save(Player player) {
        players.remove(player);
        players.add(player);
    }
}
