package net.dongeronimo.gauntlet.entities;

/**
 * O eixo GROSSO da descrição de uma célula: a única pergunta que colisão,
 * line-of-sight e pathfinding fazem. Eles leem SÓ isto, nunca o tipo — é o que
 * permite inventar tipo novo (grama, água, lava) sem tocar em nenhum desses
 * sistemas, no server ou no client.
 */
public enum CellCategory {
    WALL("wall"),
    PASSABLE("passable");

    private final String wire;

    CellCategory(String wire) {
        this.wire = wire;
    }

    /** Nome no JSON do mapSync — espelhado no client (dto/ServerMessage.ts). */
    public String wire() {
        return wire;
    }
}
