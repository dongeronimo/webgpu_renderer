package net.dongeronimo.gauntlet.services;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

import org.junit.jupiter.api.Test;

import net.dongeronimo.gauntlet.entities.CellCategory;
import net.dongeronimo.gauntlet.entities.CellType;
import net.dongeronimo.gauntlet.entities.GameMap;
import net.dongeronimo.gauntlet.entities.MapCell;

/**
 * Prova as PROPRIEDADES do gerador, não um layout específico: borda sólida,
 * spawns válidos e — a que paga o aluguel — todo chão alcançável a partir do
 * spawn (a ligação em cadeia das salas promete isso; o BFS cobra a promessa).
 */
public class MapGeneratorTest {
    private final MapGenerator generator = new MapGenerator();

    /** Chave do flood fill. NÃO dá pra usar MapCell: ele carrega tipo e extras,
     *  então dois "mesmo lugar" com conteúdo diferente não seriam iguais. */
    private record Pos(int x, int z) {}

    @Test
    void mesmoSeedMesmoMapa() {
        GameMap a = generator.generate(42L);
        GameMap b = generator.generate(42L);
        assertEquals(a.toRows(), b.toRows());
        assertEquals(a.getPlayerSpawns(), b.getPlayerSpawns());
    }

    @Test
    void propriedadesValemPraQualquerSeed() {
        for (long seed = 0; seed < 25; seed++) {
            GameMap map = generator.generate(seed);
            assertEquals(MapGenerator.WIDTH, map.getWidth());
            assertEquals(MapGenerator.HEIGHT, map.getHeight());

            //borda: anel externo inteiro é parede
            for (int x = 0; x < map.getWidth(); x++) {
                assertEquals(CellCategory.WALL, map.get(x, 0).category(), "seed " + seed);
                assertEquals(CellCategory.WALL, map.get(x, map.getHeight() - 1).category(), "seed " + seed);
            }
            for (int z = 0; z < map.getHeight(); z++) {
                assertEquals(CellCategory.WALL, map.get(0, z).category(), "seed " + seed);
                assertEquals(CellCategory.WALL, map.get(map.getWidth() - 1, z).category(), "seed " + seed);
            }

            //toda célula se descreve: os dois únicos tipos de hoje, e categoria
            //sempre coerente com o tipo (é o tipo que manda — ver CellType)
            for (MapCell cell : map.getCells()) {
                assertTrue(cell.type() == CellType.BASIC_WALL || cell.type() == CellType.DIRT_GROUND,
                    "seed " + seed + " tipo inesperado " + cell.type());
                assertEquals(cell.type().category(), cell.category(), "seed " + seed);
            }

            //spawns: 4, em células distintas, e em chão
            var spawns = map.getPlayerSpawns();
            assertEquals(4, spawns.size(), "seed " + seed);
            assertEquals(4, spawns.stream().map(c -> new Pos(c.x(), c.z())).distinct().count(), "seed " + seed);
            for (MapCell spawn : spawns) {
                assertTrue(spawn.isPassable(), "seed " + seed + " spawn " + spawn);
            }

            //saída: existe uma só, e é chão (semântica em extra, não em tipo)
            var saidas = map.getCells().stream().filter(c -> c.hasExtra(GameMap.EXTRA_EXIT)).toList();
            assertEquals(1, saidas.size(), "seed " + seed);
            assertTrue(saidas.getFirst().isPassable(), "seed " + seed);

            //conectividade: BFS 4-vizinhos a partir do spawn alcança TODO andável
            MapCell primeiroSpawn = spawns.getFirst();
            int alcancados = floodFrom(map, new Pos(primeiroSpawn.x(), primeiroSpawn.z()));
            assertEquals(contaAndaveis(map), alcancados, "seed " + seed + ": chão inalcançável");
        }
    }

    @Test
    void imprimeUmaDungeonPraOlhar() {
        GameMap map = generator.generate(42L);
        map.toRows().forEach(System.out::println);
        System.out.println("spawns: " + map.getPlayerSpawns());
    }

    private int contaAndaveis(GameMap map) {
        int total = 0;
        for (int z = 0; z < map.getHeight(); z++)
            for (int x = 0; x < map.getWidth(); x++)
                if (map.isWalkable(x, z))
                    total++;
        return total;
    }

    private int floodFrom(GameMap map, Pos start) {
        Set<Pos> visitados = new HashSet<>();
        ArrayDeque<Pos> fila = new ArrayDeque<>();
        fila.add(start);
        visitados.add(start);
        int[][] vizinhos = { {1, 0}, {-1, 0}, {0, 1}, {0, -1} };
        while (!fila.isEmpty()) {
            Pos atual = fila.poll();
            for (int[] d : vizinhos) {
                Pos prox = new Pos(atual.x() + d[0], atual.z() + d[1]);
                if (map.isWalkable(prox.x(), prox.z()) && visitados.add(prox)) {
                    fila.add(prox);
                }
            }
        }
        return visitados.size();
    }
}
