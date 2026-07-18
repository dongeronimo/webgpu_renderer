package net.dongeronimo.gauntlet.services;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.springframework.stereotype.Component;

import net.dongeronimo.gauntlet.entities.GameMap;

/**
 * Gera a dungeon: salas retangulares espalhadas com rejeição + corredores em L
 * ligando cada sala à anterior. Ligar em CADEIA (i → i-1) garante conectividade
 * por construção — todo chão é alcançável a partir de qualquer chão (o teste
 * prova isso por BFS).
 *
 * O seed existe pra teste/reprodução SERVER-SIDE. Pro client o mapa é sempre
 * DADO (rows no mapSync), nunca seed — não existe procgen compartilhado.
 */
@Component
public class MapGenerator {
    public static final int WIDTH  = 32;
    public static final int HEIGHT = 32;
    private static final int ROOM_MIN = 4;   //>=4 pros 4 spawns caberem na sala inicial
    private static final int ROOM_MAX = 8;
    private static final int ROOM_TRIES = 40;

    /** Sala candidata; células da sala = [x, x+w) × [z, z+h). */
    private record Room(int x, int z, int w, int h) {
        int centerX() { return x + w / 2; }
        int centerZ() { return z + h / 2; }
        /** Overlap com 1 célula de folga: garante parede entre salas vizinhas. */
        boolean touches(Room o) {
            return x - 1 < o.x + o.w && o.x - 1 < x + w
                && z - 1 < o.z + o.h && o.z - 1 < z + h;
        }
    }

    public GameMap generate() {
        return generate(new Random().nextLong());
    }

    public GameMap generate(long seed) {
        Random rng = new Random(seed);
        GameMap map = new GameMap(WIDTH, HEIGHT); //nasce tudo WALL

        //1) Espalha salas com rejeição. Range de posição deixa o anel da borda
        //   sempre sólido (client não precisa tratar "andei pra fora do mundo").
        List<Room> rooms = new ArrayList<>();
        for (int i = 0; i < ROOM_TRIES; i++) {
            int w = ROOM_MIN + rng.nextInt(ROOM_MAX - ROOM_MIN + 1);
            int h = ROOM_MIN + rng.nextInt(ROOM_MAX - ROOM_MIN + 1);
            int x = 1 + rng.nextInt(WIDTH - w - 2);
            int z = 1 + rng.nextInt(HEIGHT - h - 2);
            Room candidate = new Room(x, z, w, h);
            if (rooms.stream().noneMatch(candidate::touches)) {
                rooms.add(candidate);
            }
        }
        //A 1ª tentativa nunca é rejeitada (mapa vazio), então rooms nunca é vazio.

        //2) Cava as salas.
        for (Room r : rooms) {
            for (int z = r.z(); z < r.z() + r.h(); z++)
                for (int x = r.x(); x < r.x() + r.w(); x++)
                    map.set(x, z, GameMap.FLOOR);
        }

        //3) Corredores em L: cada sala liga na anterior, centro a centro.
        //   Cotovelo sorteado só pra variar a silhueta.
        for (int i = 1; i < rooms.size(); i++) {
            Room a = rooms.get(i - 1);
            Room b = rooms.get(i);
            if (rng.nextBoolean()) {
                carveH(map, a.centerX(), b.centerX(), a.centerZ());
                carveV(map, a.centerZ(), b.centerZ(), b.centerX());
            } else {
                carveV(map, a.centerZ(), b.centerZ(), a.centerX());
                carveH(map, a.centerX(), b.centerX(), b.centerZ());
            }
        }

        //4) Spawns dos 4 players: quadradinho 2x2 no centro da 1ª sala
        //   (ROOM_MIN=4 garante que cabe dentro dela).
        Room first = rooms.getFirst();
        for (int dz = 0; dz <= 1; dz++)
            for (int dx = 0; dx <= 1; dx++)
                map.getPlayerSpawns().add(new GameMap.Cell(first.centerX() + dx, first.centerZ() + dz));

        //5) EXIT (futura sala do boss) no centro da última sala. No caso
        //   degenerado de sala única, desloca pra não cair em cima de spawn.
        Room last = rooms.getLast();
        if (rooms.size() > 1) {
            map.set(last.centerX(), last.centerZ(), GameMap.EXIT);
        } else {
            map.set(last.centerX() - 1, last.centerZ() - 1, GameMap.EXIT);
        }
        return map;
    }

    /** Cava linha horizontal inclusiva entre x1 e x2 (qualquer ordem). */
    private void carveH(GameMap map, int x1, int x2, int z) {
        for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
            map.set(x, z, GameMap.FLOOR);
    }

    /** Cava linha vertical inclusiva entre z1 e z2 (qualquer ordem). */
    private void carveV(GameMap map, int z1, int z2, int x) {
        for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
            map.set(x, z, GameMap.FLOOR);
    }
}
