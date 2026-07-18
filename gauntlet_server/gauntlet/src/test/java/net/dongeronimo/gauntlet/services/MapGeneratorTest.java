package net.dongeronimo.gauntlet.services;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

import org.junit.jupiter.api.Test;

import net.dongeronimo.gauntlet.entities.GameMap;

/**
 * Prova as PROPRIEDADES do gerador, não um layout específico: borda sólida,
 * spawns válidos e — a que paga o aluguel — todo chão alcançável a partir do
 * spawn (a ligação em cadeia das salas promete isso; o BFS cobra a promessa).
 */
public class MapGeneratorTest {
    private final MapGenerator generator = new MapGenerator();

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
                assertEquals(GameMap.WALL, map.get(x, 0), "seed " + seed);
                assertEquals(GameMap.WALL, map.get(x, map.getHeight() - 1), "seed " + seed);
            }
            for (int z = 0; z < map.getHeight(); z++) {
                assertEquals(GameMap.WALL, map.get(0, z), "seed " + seed);
                assertEquals(GameMap.WALL, map.get(map.getWidth() - 1, z), "seed " + seed);
            }

            //spawns: 4, distintos, e em chão
            assertEquals(4, map.getPlayerSpawns().size(), "seed " + seed);
            assertEquals(4, Set.copyOf(map.getPlayerSpawns()).size(), "seed " + seed);
            for (GameMap.Cell spawn : map.getPlayerSpawns()) {
                assertTrue(map.isWalkable(spawn.x(), spawn.z()), "seed " + seed + " spawn " + spawn);
            }

            //conectividade: BFS 4-vizinhos a partir do spawn alcança TODO andável
            int alcancados = floodFrom(map, map.getPlayerSpawns().getFirst());
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

    private int floodFrom(GameMap map, GameMap.Cell start) {
        Set<GameMap.Cell> visitados = new HashSet<>();
        ArrayDeque<GameMap.Cell> fila = new ArrayDeque<>();
        fila.add(start);
        visitados.add(start);
        int[][] vizinhos = { {1, 0}, {-1, 0}, {0, 1}, {0, -1} };
        while (!fila.isEmpty()) {
            GameMap.Cell atual = fila.poll();
            for (int[] d : vizinhos) {
                GameMap.Cell prox = new GameMap.Cell(atual.x() + d[0], atual.z() + d[1]);
                if (map.isWalkable(prox.x(), prox.z()) && visitados.add(prox)) {
                    fila.add(prox);
                }
            }
        }
        return visitados.size();
    }
}
