package net.dongeronimo.gauntlet.persistence;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

import net.dongeronimo.gauntlet.entities.Player;

/** CRUD via Spring Data - findByName é derivada do nome do método, sem SQL escrito à mão. */
public interface PlayerRepository extends JpaRepository<Player, Long> {
    Optional<Player> findByName(String name);
}
