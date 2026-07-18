package net.dongeronimo.gauntlet.entities;

import java.util.ArrayList;
import java.util.List;

/**
 * O mundo estático da instância: matriz 2D de ocupação, row-major.
 * Ela é a single source of truth espacial: colisão, line-of-sight e
 * pathfinding leem daqui, e o payload do mapSync (rows de string estilo
 * roguelike) é derivado daqui. A matriz JÁ é um volume (chapa de
 * profundidade 1): destruição futura = flip de byte + mapDelta.
 * Tiles = geometria pura; spawns são metadado à parte, não tile.
 */
public class GameMap {
    public static final byte WALL  = 0;
    public static final byte FLOOR = 1;
    public static final byte EXIT  = 2; //onde o boss vai morar (1d)

    /** Célula do grid. Posição de MUNDO da célula = (x*tileSize, z*tileSize). */
    public record Cell(int x, int z) {}

    private final int width;
    private final int height;
    /** row-major: tiles[z*width + x] */
    private final byte[] tiles;
    /** Onde os até 4 players nascem. Metadado, não aparece nos tiles. */
    private final List<Cell> playerSpawns = new ArrayList<>();

    public GameMap(int width, int height) {
        this.width = width;
        this.height = height;
        this.tiles = new byte[width * height]; //nasce tudo WALL (byte 0)
    }

    public int getWidth() { return width; }
    public int getHeight() { return height; }
    public List<Cell> getPlayerSpawns() { return playerSpawns; }

    public byte get(int x, int z) {
        return tiles[z * width + x];
    }

    public void set(int x, int z, byte tile) {
        tiles[z * width + x] = tile;
    }

    /** Fora dos limites = parede: quem pergunta por célula inexistente colide. */
    public boolean isWalkable(int x, int z) {
        if (x < 0 || x >= width || z < 0 || z >= height)
            return false;
        return get(x, z) != WALL;
    }

    /**
     * Uma string por linha de tiles — o formato do mapSync da spec. O motivo
     * de ser texto legível: dá pra LER a dungeon no DevTools (e no surefire).
     */
    public List<String> toRows() {
        List<String> rows = new ArrayList<>(height);
        for (int z = 0; z < height; z++) {
            StringBuilder sb = new StringBuilder(width);
            for (int x = 0; x < width; x++) {
                sb.append(switch (get(x, z)) {
                    case FLOOR -> '.';
                    case EXIT -> 'E';
                    default -> '#';
                });
            }
            rows.add(sb.toString());
        }
        return rows;
    }
}
