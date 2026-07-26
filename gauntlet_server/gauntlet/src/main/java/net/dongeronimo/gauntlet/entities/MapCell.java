package net.dongeronimo.gauntlet.entities;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A descrição RICA de uma célula: onde ela está, o que ela é (tipo — e por
 * tabela a categoria) e um saco kv livre pro que não merece virar tipo.
 *
 * O exemplo que motivou os extras: a SEED da grama. Em vez de mandar um node
 * por tufo, manda-se UMA string que o gerador do client expande localmente —
 * o mapa comprime "um monte de xz de grama" num extra. Os extras também
 * absorveram o que antes era metadado paralelo aos tiles (spawn de player) ou
 * tipo-de-tile inventado só pra marcar semântica (a saída) — ver GameMap.EXTRA_*.
 *
 * IMUTÁVEL: mudar uma célula = trocar a célula (GameMap.set/putExtra). É o que
 * mantém destruição futura simples — trocar a célula + mandar mapDelta só dela.
 */
public record MapCell(int x, int z, CellType type, Map<String, String> extras) {
    /** Defensiva: ninguém segura referência pro mapa de extras de uma célula. */
    public MapCell {
        extras = (extras == null || extras.isEmpty()) ? Map.of() : Map.copyOf(extras);
    }

    public static MapCell of(int x, int z, CellType type) {
        return new MapCell(x, z, type, Map.of());
    }

    public CellCategory category() {
        return type.category();
    }

    public boolean isPassable() {
        return type.category() == CellCategory.PASSABLE;
    }

    /** null se a célula não tiver esse extra. */
    public String extra(String key) {
        return extras.get(key);
    }

    public boolean hasExtra(String key) {
        return extras.containsKey(key);
    }

    /** Mesma posição e MESMOS extras, tipo novo — trocar o material do chão
     *  não apaga a grama que mora nele. */
    public MapCell withType(CellType newType) {
        return new MapCell(x, z, newType, extras);
    }

    public MapCell withExtra(String key, String value) {
        Map<String, String> novos = new LinkedHashMap<>(extras);
        novos.put(key, value);
        return new MapCell(x, z, type, novos);
    }
}
