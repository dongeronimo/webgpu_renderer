package net.dongeronimo.gauntlet.entities;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * O mundo estático da instância: matriz 2D de CÉLULAS RICAS (MapCell),
 * row-major. Ela é a single source of truth espacial: colisão, line-of-sight e
 * pathfinding leem daqui (pela CATEGORIA), e o payload do mapSync é derivado
 * daqui célula a célula. A matriz JÁ é um volume (chapa de profundidade 1):
 * destruição futura = trocar a célula + mapDelta.
 *
 * Foi uma matriz de bytes (WALL/FLOOR/EXIT) com metadado paralelo do lado
 * (a lista de spawns). Não escalava: tudo que não coubesse num byte virava
 * campo novo no mapa ou tipo-de-tile inventado. Agora a célula se descreve
 * inteira — categoria (o que os sistemas leem), tipo (o que o client
 * instancia) e extras kv (o resto: spawn, saída, seed de grama...).
 */
public class GameMap {
    /** Extra da célula onde um player nasce. Valor = índice do spawn ("0".."3"),
     *  que é também a ordem em que getPlayerSpawns() devolve. Antes era uma
     *  List&lt;Cell&gt; à parte — virou extra porque É descrição da célula. */
    public static final String EXTRA_PLAYER_SPAWN = "playerSpawn";
    /** Extra da célula de saída (onde o boss vai morar, 1d). Valor "true".
     *  Antes era um TIPO de tile (EXIT), o que misturava semântica de gameplay
     *  com material do chão — a saída é chão de terra igual aos outros. */
    public static final String EXTRA_EXIT = "exit";
    /**
     * Extra do chão que tem grama. Valor = um u32 em 8 hex minúsculos
     * ("1f8f31c2"), com DUAS informações empacotadas:
     * <ul>
     *   <li>bits 24..31 — DENSIDADE (0..255): quantos tufos o client planta.
     *       Quem decide é o server porque a densidade vem da forma da dungeon
     *       (ver MapGenerator), que só ele conhece.</li>
     *   <li>bits 0..23 — SEED de distribuição: de onde o client tira posição,
     *       rotação e escala de cada tufo.</li>
     * </ul>
     * Ausente = sem grama nenhuma; não existe densidade 0 no fio.
     *
     * É a razão de os extras existirem: uma célula com 40 tufos custa 8 chars
     * no mapSync em vez de 40 posições, e o client expande localmente. O que
     * viaja é DADO (o valor pronto), não procgen compartilhado — o client nunca
     * roda o gerador do server, só desempacota isto.
     */
    public static final String EXTRA_GRASS_SEED = "grassSeed";

    private final int width;
    private final int height;
    /** row-major: cells[z*width + x]. Nunca tem null depois do construtor. */
    private final MapCell[] cells;

    public GameMap(int width, int height) {
        this.width = width;
        this.height = height;
        this.cells = new MapCell[width * height];
        for (int z = 0; z < height; z++)
            for (int x = 0; x < width; x++)
                cells[z * width + x] = MapCell.of(x, z, CellType.BASIC_WALL); //nasce tudo parede
    }

    public int getWidth() { return width; }
    public int getHeight() { return height; }

    /** @throws ArrayIndexOutOfBoundsException fora do grid — quem pode estar
     *  fora pergunta com getOrNull/isWalkable. */
    public MapCell get(int x, int z) {
        return cells[z * width + x];
    }

    /** null fora do grid. */
    public MapCell getOrNull(int x, int z) {
        if (x < 0 || x >= width || z < 0 || z >= height)
            return null;
        return get(x, z);
    }

    /** Troca o TIPO preservando os extras (ver MapCell.withType). */
    public void set(int x, int z, CellType type) {
        cells[z * width + x] = get(x, z).withType(type);
    }

    public void putExtra(int x, int z, String key, String value) {
        cells[z * width + x] = get(x, z).withExtra(key, value);
    }

    /** Fora dos limites = parede: quem pergunta por célula inexistente colide. */
    public boolean isWalkable(int x, int z) {
        MapCell cell = getOrNull(x, z);
        return cell != null && cell.isPassable();
    }

    /** Todas as células, row-major (índice = z*width + x) — é esta ordem que o
     *  mapSync manda no fio, e é dela que o client tira x/z sem precisar que
     *  cada célula carregue a própria posição. */
    public List<MapCell> getCells() {
        return List.of(cells);
    }

    /** As células marcadas com EXTRA_PLAYER_SPAWN, na ordem do índice gravado
     *  nele. DERIVADO dos extras: não existe mais lista paralela pra sair de
     *  sincronia com a matriz. */
    public List<MapCell> getPlayerSpawns() {
        List<MapCell> spawns = new ArrayList<>(4);
        for (MapCell cell : cells)
            if (cell.hasExtra(EXTRA_PLAYER_SPAWN))
                spawns.add(cell);
        spawns.sort(Comparator.comparingInt(c -> Integer.parseInt(c.extra(EXTRA_PLAYER_SPAWN))));
        return spawns;
    }

    /**
     * Vista de DEBUG do mapa, uma string por linha, estilo roguelike — dá pra
     * LER a dungeon no surefire/log. Não é mais o formato do fio (o mapSync
     * manda célula a célula agora): é só pra olho humano, e por isso pode
     * mostrar o que o formato antigo não mostrava (S de spawn).
     */
    public List<String> toRows() {
        List<String> rows = new ArrayList<>(height);
        for (int z = 0; z < height; z++) {
            StringBuilder sb = new StringBuilder(width);
            for (int x = 0; x < width; x++) {
                MapCell cell = get(x, z);
                if (!cell.isPassable())
                    sb.append('#');
                else if (cell.hasExtra(EXTRA_PLAYER_SPAWN))
                    sb.append('S');
                else if (cell.hasExtra(EXTRA_EXIT))
                    sb.append('E');
                else
                    sb.append('.');
            }
            rows.add(sb.toString());
        }
        return rows;
    }
}
