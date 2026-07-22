package net.dongeronimo.gauntlet.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

import net.dongeronimo.gauntlet.entities.PlayerControllerSettings;

public interface PlayerControllerSettingsRepository extends JpaRepository<PlayerControllerSettings, Long> {
}
