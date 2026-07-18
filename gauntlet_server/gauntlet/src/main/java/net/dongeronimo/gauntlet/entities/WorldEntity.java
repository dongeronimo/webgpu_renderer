package net.dongeronimo.gauntlet.entities;

/**
 * Entidade do mundo: PLANA, sem scene graph — server autoritativo só guarda
 * estado de jogo, apresentação é problema do client (kind→prefab é tabela de
 * lá). Colisão vem depois como primitivas (círculo vs célula), sem hierarquia.
 */
public class WorldEntity {
    /** Identidade de ENTIDADE, atribuída pela instância — não confundir com id de conta. */
    private final long id;
    /** "player" por ora; "monster" e afins entram no 1b. */
    private final String kind;
    /** Pra kind=player: o id da CONTA dona do pawn. Pros outros kinds não significa nada. */
    private final long owner;
    private double x;
    private double z;
    private double yaw;

    public WorldEntity(long id, String kind, long owner, double x, double z, double yaw) {
        this.id = id;
        this.kind = kind;
        this.owner = owner;
        this.x = x;
        this.z = z;
        this.yaw = yaw;
    }

    public long getId() { return id; }
    public String getKind() { return kind; }
    public long getOwner() { return owner; }
    public double getX() { return x; }
    public double getZ() { return z; }
    public double getYaw() { return yaw; }
    public void setX(double x) { this.x = x; }
    public void setZ(double z) { this.z = z; }
    public void setYaw(double yaw) { this.yaw = yaw; }
}
