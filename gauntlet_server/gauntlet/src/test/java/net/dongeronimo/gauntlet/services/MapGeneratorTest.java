package net.dongeronimo.gauntlet.services;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

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
        //célula a célula, extras inclusive: toRows() não mostra grama, e é a
        //grama que tem o hash — se ele vazasse não-determinismo, seria aqui
        assertEquals(a.getCells(), b.getCells());
    }

    @Test
    void gramaSoNasceEmChaoENoFormatoDoFio() {
        Set<Integer> seeds = new HashSet<>();
        int celulasComGrama = 0;
        for (long seed = 0; seed < 25; seed++) {
            GameMap map = generator.generate(seed);
            for (MapCell cell : map.getCells()) {
                String grama = cell.extra(GameMap.EXTRA_GRASS_SEED);
                if (grama == null) {
                    continue; //parede, ou chão apertado demais: ausência = sem grama
                }
                assertEquals(CellType.DIRT_GROUND, cell.type(), "seed " + seed + " " + cell);
                //u32 em 8 hex minúsculos — ver GameMap.EXTRA_GRASS_SEED
                assertTrue(grama.matches("[0-9a-f]{8}"), "seed " + seed + " grassSeed=" + grama);
                int packed = Integer.parseUnsignedInt(grama, 16);
                //densidade 0 não vai no fio: quem não tem grama não tem o extra
                assertTrue((packed >>> 24) > 0, "seed " + seed + " densidade 0 em " + grama);
                seeds.add(packed & 0xFFFFFF);
                celulasComGrama++;
            }
        }
        //o hash tem que ESPALHAR: se ele ignorasse x, z ou o seed do mapa, a
        //contagem de valores distintos desabaria (é isso que este número pega)
        assertTrue(seeds.size() > celulasComGrama * 9 / 10,
            "seeds repetindo demais: " + seeds.size() + " distintas em " + celulasComGrama + " células");
    }

    @Test
    void densidadeDaGramaCresceComAAbertura() {
        //abertura → densidade tem que ser FUNÇÃO (mesma abertura em qualquer
        //mapa, mesma densidade) e estritamente crescente: rala perto de parede,
        //cheia em área aberta. É o que faz a silhueta da dungeon aparecer.
        Map<Integer, Integer> porAbertura = new TreeMap<>();
        for (long seed = 0; seed < 10; seed++) {
            GameMap map = generator.generate(seed);
            for (MapCell cell : map.getCells()) {
                String grama = cell.extra(GameMap.EXTRA_GRASS_SEED);
                if (grama == null) continue;
                int densidade = Integer.parseUnsignedInt(grama, 16) >>> 24;
                Integer anterior = porAbertura.put(abertura(map, cell.x(), cell.z()), densidade);
                assertTrue(anterior == null || anterior == densidade,
                    "abertura " + abertura(map, cell.x(), cell.z()) + " deu densidades diferentes");
            }
        }
        int ultima = -1;
        for (var e : porAbertura.entrySet()) {
            assertTrue(e.getValue() > ultima, "densidade não cresceu na abertura " + e.getKey());
            ultima = e.getValue();
        }
        //ROOM_MIN=4 garante sala com interior, então célula 100% cercada de chão
        //sempre existe — e ela é o teto da escala
        assertEquals(255, porAbertura.get(8).intValue(), "célula totalmente aberta não deu densidade máxima");
    }

    /** Re-derivação independente da abertura usada pelo gerador (8 vizinhos,
     *  fora do grid = parede) — o teste não pode chamar o método privado dele. */
    private int abertura(GameMap map, int x, int z) {
        int n = 0;
        for (int dz = -1; dz <= 1; dz++)
            for (int dx = -1; dx <= 1; dx++)
                if ((dx != 0 || dz != 0) && map.isWalkable(x + dx, z + dz))
                    n++;
        return n;
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
        //densidade da grama em 1 char por célula (0..f = nibble alto): dá pra
        //VER no surefire se a vegetação está engrossando pro meio das salas
        System.out.println("grama:");
        for (int z = 0; z < map.getHeight(); z++) {
            StringBuilder linha = new StringBuilder(map.getWidth());
            for (int x = 0; x < map.getWidth(); x++) {
                String grama = map.get(x, z).extra(GameMap.EXTRA_GRASS_SEED);
                linha.append(grama == null ? ' '
                    : Character.forDigit(Integer.parseUnsignedInt(grama, 16) >>> 28, 16));
            }
            System.out.println(linha);
        }
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
