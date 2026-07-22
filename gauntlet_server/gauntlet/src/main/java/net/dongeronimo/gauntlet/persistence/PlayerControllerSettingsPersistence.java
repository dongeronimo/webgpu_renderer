package net.dongeronimo.gauntlet.persistence;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

import net.dongeronimo.gauntlet.entities.PlayerControllerSettings;

/**
 * Uma linha por personagem jogável, lida e CACHEADA uma única vez aqui no
 * construtor (não a cada get()) - GameLoop (autoridade do movimento) e
 * PlayerControllerSettingsController (o que o client baixa no login) têm que
 * enxergar EXATAMENTE o mesmo snapshot, senão client e server calibram a
 * predição local com valores diferentes. Editar as linhas direto no
 * /h2-console (sem REST de escrita por ora) e reiniciar o server pra valer -
 * não tem hot-reload.
 */
@Service
public class PlayerControllerSettingsPersistence {
    private final Map<String, PlayerControllerSettings> byCharacter;

    //Seed INCREMENTAL, não só "se a tabela estiver vazia": só insere as
    //linhas de defaults() que ainda não existem (por character), então
    //adicionar um personagem novo aqui é só isso - reiniciar o server já
    //preenche a linha que falta, sem apagar as que você editou no
    ///h2-console. A checagem null/"" ainda cobre o formato ANTIGO (linha
    //única id=1 sem character, ou a sobrevivente do @ColumnDefault("''") do
    //ALTER de quando este campo nasceu - ver PlayerControllerSettings) -
    //essas não servem pro lookup por personagem e são descartadas.
    public PlayerControllerSettingsPersistence(PlayerControllerSettingsRepository repository) {
        List<PlayerControllerSettings> existing = repository.findAll();
        if (existing.stream().anyMatch(s -> s.getCharacter() == null || s.getCharacter().isBlank())) {
            repository.deleteAll();
            existing = List.of();
        }
        Set<String> known = existing.stream().map(PlayerControllerSettings::getCharacter).collect(Collectors.toSet());
        List<PlayerControllerSettings> missing = defaults().stream()
            .filter(d -> !known.contains(d.getCharacter()))
            .toList();
        if (!missing.isEmpty()) {
            existing = new ArrayList<>(existing);
            existing.addAll(repository.saveAll(missing));
        }
        this.byCharacter = existing.stream()
            .collect(Collectors.toUnmodifiableMap(PlayerControllerSettings::getCharacter, s -> s));
    }

    //Um espectro de arquétipos, não só números aleatórios: Dmitry (shock
    //trooper) robusto e lento; Nat (oficial científica) ágil; Abigail
    //(espiã do Mossad) a mais rápida e a mais frágil (raio menor); Ramirez
    //(soldado tipo Rambo) o mais "grandão" - maior raio, mas arranca rápido
    //(accel alto). Yukio (yakuza) ainda NÃO tem linha aqui de propósito -
    //personagem não pronto, sem prefab; o botão dele fica grayed-out na UI
    //(ver GauntletCharacterSelectPanel.tsx) e SignalingWS rejeita
    //("badCharacter") se alguém tentar escolhê-lo mesmo assim. ids fixos e
    //pequenos (não @GeneratedValue - ver PlayerControllerSettings): são
    //linhas de config, não uma tabela que cresce por conta própria.
    private static List<PlayerControllerSettings> defaults() {
        return List.of(
            new PlayerControllerSettings(1, "Dmitry", 3.0, 1.5, 20.0, 90.0, 0.05, 0.32, 1.5),
            new PlayerControllerSettings(2, "Nat", 3.6, 1.9, 24.0, 110.0, 0.05, 0.26, 1.5),
            new PlayerControllerSettings(3, "Abigail", 4.0, 2.2, 28.0, 130.0, 0.05, 0.22, 1.5),
            new PlayerControllerSettings(4, "Ramirez", 3.2, 1.6, 30.0, 95.0, 0.05, 0.34, 1.5)
        );
    }

    /** @throws IllegalArgumentException se `character` não tiver linha - chame
     *  {@link #isKnownCharacter(String)} antes quando a entrada vier de fora
     *  (client), pra responder um erro legível em vez de deixar isto explodir. */
    public PlayerControllerSettings get(String character) {
        PlayerControllerSettings settings = byCharacter.get(character);
        if (settings == null) {
            throw new IllegalArgumentException("PlayerControllerSettings: personagem desconhecido: " + character);
        }
        return settings;
    }

    public boolean isKnownCharacter(String character) {
        return byCharacter.containsKey(character);
    }

    /** Todas as linhas, cacheadas — GameLoop monta o próprio Map indexado
     *  (convertendo giro pra radianos) uma vez no construtor a partir disto. */
    public Map<String, PlayerControllerSettings> getAll() {
        return byCharacter;
    }
}
