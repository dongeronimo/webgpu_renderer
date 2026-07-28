package net.dongeronimo.gauntlet.services;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Random;

import org.springframework.stereotype.Component;

import net.dongeronimo.gauntlet.entities.CellType;
import net.dongeronimo.gauntlet.entities.GameMap;

/**
 * Gera a dungeon: salas retangulares espalhadas com rejeição + corredores em L
 * ligando cada sala à anterior. Ligar em CADEIA (i → i-1) garante conectividade
 * por construção — todo chão é alcançável a partir de qualquer chão (o teste
 * prova isso por BFS).
 *
 * O seed do gerador existe pra teste/reprodução SERVER-SIDE e NUNCA sai daqui:
 * pro client o mapa é sempre DADO (célula a célula no mapSync), não existe
 * procgen compartilhado. Não confundir com a seed de GRAMA, que vai no fio: ela
 * não regenera mapa nenhum, é só um valor pronto que o client desempacota pra
 * decorar uma célula que ele já recebeu descrita.
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

        //2) Cava as salas. Chão é DIRT_GROUND por ora — quando existir variação
        //   de MATERIAL (água, lava...) é aqui que ela é escolhida. Decoração que
        //   não muda andabilidade não vira tipo novo: entra como extra da célula,
        //   depois que a geometria estiver pronta (a grama é a etapa 6).
        for (Room r : rooms) {
            for (int z = r.z(); z < r.z() + r.h(); z++)
                for (int x = r.x(); x < r.x() + r.w(); x++)
                    map.set(x, z, CellType.DIRT_GROUND);
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
        //   (ROOM_MIN=4 garante que cabe dentro dela). Marcados como EXTRA na
        //   própria célula — não existe mais lista de spawns paralela à matriz.
        Room first = rooms.getFirst();
        int spawnIndex = 0;
        for (int dz = 0; dz <= 1; dz++)
            for (int dx = 0; dx <= 1; dx++)
                map.putExtra(first.centerX() + dx, first.centerZ() + dz,
                    GameMap.EXTRA_PLAYER_SPAWN, Integer.toString(spawnIndex++));

        //5) Saída (futura sala do boss) no centro da última sala. Extra, não
        //   tipo de célula: continua sendo chão de terra normal — a saída é
        //   semântica de gameplay, não material. No caso degenerado de sala
        //   única, desloca pra não cair em cima de spawn.
        Room last = rooms.getLast();
        if (rooms.size() > 1) {
            map.putExtra(last.centerX(), last.centerZ(), GameMap.EXTRA_EXIT, "true");
        } else {
            map.putExtra(last.centerX() - 1, last.centerZ() - 1, GameMap.EXTRA_EXIT, "true");
        }

        //6) Grama. Por último de propósito: a densidade depende da ABERTURA da
        //   célula, que só existe depois de toda a geometria cavada. Cada chão de
        //   terra ganha o extra grassSeed (densidade + seed empacotadas — ver
        //   GameMap.EXTRA_GRASS_SEED); o client expande isso em N tufos sozinho.
        for (int z = 0; z < HEIGHT; z++) {
            for (int x = 0; x < WIDTH; x++) {
                if (map.get(x, z).type() != CellType.DIRT_GROUND)
                    continue;
                int density = grassDensity(openness(map, x, z));
                if (density == 0)
                    continue; //sem grama é extra AUSENTE, não "00xxxxxx" no fio
                int packed = (density << 24) | (cellHash(x, z, seed) & 0xFFFFFF);
                map.putExtra(x, z, GameMap.EXTRA_GRASS_SEED,
                    String.format(Locale.ROOT, "%08x", packed));
            }
        }
        return map;
    }

    /** Quantos dos 8 vizinhos (Moore) são andáveis. Fora do grid conta como
     *  parede, igual em todo o resto do sistema (GameMap.isWalkable). Diagonal
     *  entra na conta porque é o que diferencia "canto de sala" de "corredor". */
    private int openness(GameMap map, int x, int z) {
        int n = 0;
        for (int dz = -1; dz <= 1; dz++)
            for (int dx = -1; dx <= 1; dx++)
                if ((dx != 0 || dz != 0) && map.isWalkable(x + dx, z + dz))
                    n++;
        return n;
    }

    /**
     * Abertura (0..8) → densidade (0..255). QUADRÁTICA, não linear: perto de
     * parede a grama some rápido e só engrossa em área aberta de verdade —
     * corredor de 1 célula (abertura 2) dá 15, meio de sala (abertura 8) dá 255.
     * Assim a silhueta da dungeon aparece na vegetação sem ninguém pintar grama
     * à mão.
     *
     * Aritmética inteira de propósito: Math.pow só promete 1 ulp, e este número
     * VAI PRO FIO — vale a pena ser bit-idêntico em qualquer JVM.
     */
    private static int grassDensity(int openness) {
        return openness * openness * 255 / 64;
    }

    /**
     * Hash 32-bit de (célula, seed do mapa) — a fonte da seed de cada tufo.
     * POSICIONAL em vez de sorteado do `rng`: a grama de uma célula não pode
     * mudar porque alguém mexeu em quantos sorteios as etapas anteriores fazem.
     * Multiplicação de int em Java já tem wraparound, que é justamente o que faz
     * o misturador espalhar os bits.
     */
    private static int cellHash(int x, int z, long seed) {
        int h = (int) (seed ^ (seed >>> 32));
        h ^= x * 0x27d4eb2d;
        h ^= z * 0x165667b1;
        h ^= h >>> 15; h *= 0x2c1b3c6d;
        h ^= h >>> 12; h *= 0x297a2d39;
        h ^= h >>> 15;
        return h;
    }

    /** Cava linha horizontal inclusiva entre x1 e x2 (qualquer ordem). */
    private void carveH(GameMap map, int x1, int x2, int z) {
        for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
            map.set(x, z, CellType.DIRT_GROUND);
    }

    /** Cava linha vertical inclusiva entre z1 e z2 (qualquer ordem). */
    private void carveV(GameMap map, int z1, int z2, int x) {
        for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
            map.set(x, z, CellType.DIRT_GROUND);
    }
}
