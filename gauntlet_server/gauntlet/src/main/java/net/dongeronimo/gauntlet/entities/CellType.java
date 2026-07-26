package net.dongeronimo.gauntlet.entities;

/**
 * O tipo DENTRO da categoria — é ele que decide qual arte o client instancia.
 * A categoria é propriedade do TIPO, não um campo solto na célula: assim não
 * existe combinação ilegal ("parede que dá pra atravessar") nem duas fontes de
 * verdade sobre andabilidade.
 *
 * Só dois por ora; variação nova de chão/parede entra AQUI (mais uma constante),
 * não como campo novo na célula.
 */
public enum CellType {
    BASIC_WALL(CellCategory.WALL, "basicWall"),
    DIRT_GROUND(CellCategory.PASSABLE, "dirtGround");

    private final CellCategory category;
    private final String wire;

    CellType(CellCategory category, String wire) {
        this.category = category;
        this.wire = wire;
    }

    public CellCategory category() {
        return category;
    }

    /** Nome no JSON do mapSync — espelhado no client (GauntletNetwork.ts). */
    public String wire() {
        return wire;
    }
}
