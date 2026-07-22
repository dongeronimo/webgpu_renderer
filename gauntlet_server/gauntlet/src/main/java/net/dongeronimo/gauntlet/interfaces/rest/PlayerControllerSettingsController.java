package net.dongeronimo.gauntlet.interfaces.rest;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import net.dongeronimo.gauntlet.entities.PlayerControllerSettings;
import net.dongeronimo.gauntlet.interfaces.transferObjects.PlayerControllerSettingsDto;
import net.dongeronimo.gauntlet.persistence.PlayerControllerSettingsPersistence;

/**
 * Só GET, só pra distribuir os valores que GameLoop já está rodando (lidos
 * uma vez no boot) pro client calibrar a predição local - sem isto o client
 * fica preso na constante hardcoded que diverge da tabela e treme
 * (rubber-band) a cada snap. Por personagem: o client só sabe qual pedir
 * DEPOIS do modal de escolha (ver connectSignaling em GauntletNetwork.ts) -
 * é o mesmo character que depois viaja no JoinRequest. Liberado só pra
 * ROLE_PLAYER em SecurityConfig. Sem POST/PUT por ora: editar a tabela é via
 * /h2-console.
 */
@RestController
public class PlayerControllerSettingsController {
    private final PlayerControllerSettingsPersistence persistence;

    public PlayerControllerSettingsController(PlayerControllerSettingsPersistence persistence) {
        this.persistence = persistence;
    }

    @GetMapping("/api/player-controller-settings/{character}")
    public PlayerControllerSettingsDto get(@PathVariable String character) {
        if (!persistence.isKnownCharacter(character)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "personagem desconhecido: " + character);
        }
        PlayerControllerSettings s = persistence.get(character);
        return new PlayerControllerSettingsDto(s.getMoveSpeedForward(), s.getMoveSpeedBackward(), s.getAccel(),
            s.getAngularVelocityDegPerSec(), s.getMoveStateEpsilon(), s.getPlayerRadius(), s.getIdleTurnMultiplier());
    }
}
