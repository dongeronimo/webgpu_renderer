package net.dongeronimo.gauntlet.persistence;

import java.util.Optional;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.Player;

@Service
public class PlayerPersistence {
    private final PlayerRepository repository;

    //Seed de dev (Alice/Bob) só na PRIMEIRA vez que o banco está vazio - depois
    //disso os dados ficam de verdade no H2 (./data/gauntlet), sobrevivendo a
    //restart. id=0 pro Hibernate tratar como INSERT (gerado pelo banco), não
    //update de uma linha existente.
    public PlayerPersistence(PlayerRepository repository) {
        this.repository = repository;
        if (repository.count() == 0) {
            repository.save(new Player(0, "Alice", "{noop}foobar"));
            repository.save(new Player(0, "Bob", "{noop}lorenipsun"));
        }
    }

    public Optional<Player> findByName(String name) {
        return repository.findByName(name);
    }

    public void save(Player player) {
        repository.save(player);
    }
}
