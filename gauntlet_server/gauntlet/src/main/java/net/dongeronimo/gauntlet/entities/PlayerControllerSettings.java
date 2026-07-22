package net.dongeronimo.gauntlet.entities;

import org.hibernate.annotations.ColumnDefault;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

/**
 * Uma linha POR PERSONAGEM jogável (hoje "Dmitry"/"Nat" - mesma string usada
 * no client como nome do prefab, em JoinRequest.character e EntityDto.character:
 * uma chave só, sem tabela de tradução) - lida UMA VEZ no boot (ver
 * services.GameLoop, persistence.PlayerControllerSettingsPersistence), não a
 * cada tick. Editar as linhas no /h2-console e reiniciar o server pra valer
 * (sem hot-reload/REST de escrita por ora).
 */
@Entity
@Table(name = "player_controller_settings", uniqueConstraints = @UniqueConstraint(columnNames = "character_key"))
public class PlayerControllerSettings {
    //SEM @GeneratedValue de propósito: são só 2-3 linhas fixas, editadas à
    //mão no /h2-console (mesmo espírito do id=1 hardcoded que isto era antes
    //de virar por-personagem) — id atribuído em
    //PlayerControllerSettingsPersistence.defaults(). Não confundir com
    //Player.id, que É gerado (a tabela de contas cresce de verdade).
    @Id
    private long id;
    //Chave de negócio: "Dmitry", "Nat" etc. - o que liga esta linha à
    //escolha do player (ver Player.character) e à entidade viva no mundo
    //(WorldEntity.character/EntityDto.character). Coluna "character_key" (não
    //"character") de propósito - CHARACTER é palavra reservada em SQL/H2.
    //@ColumnDefault (não só nullable=false): sem um DEFAULT o ddl-auto=update
    //do Hibernate não consegue ADD COLUMN NOT NULL numa tabela que já tem
    //linha (H2 recria a tabela copiando os dados, e a linha antiga não tem
    //valor pra essa coluna nova → viola o NOT NULL, ALTER inteiro falha). O
    //default '' é só pra essa migração passar; PlayerControllerSettingsPersistence
    //reconhece '' como "formato antigo" e reapaga+ressemeia as linhas de verdade.
    @Column(name = "character_key", nullable = false)
    @ColumnDefault("''")
    private String character;
    //cells/segundo (1 cell = 1 unidade) - velocidade de cruzeiro andando pra
    //FRENTE (move>0).
    @Column(nullable = false)
    private double moveSpeedForward;
    //cells/segundo - velocidade de cruzeiro andando pra TRÁS (move<0) -
    //separada da de frente de propósito, pra poder ser mais lenta (ver
    //GameLoop.stepMovement, escolhida pelo sinal de move).
    @Column(nullable = false)
    private double moveSpeedBackward;
    //cells/segundo² - quão rápido a velocidade CORRENTE alcança a intenção
    //(GameLoop.stepMovement/moveToward). MOVE_SPEED/ACCEL = tempo (s) do
    //zero até a velocidade máxima.
    @Column(nullable = false)
    private double accel;
    //graus/segundo - ritmo do giro (A/D). Fica em GRAUS aqui (mais fácil de
    //editar a olho que radianos); GameLoop converte pra radianos no boot -
    //espelhar em MineAvatarBehaviour.ANGULAR_VELOCITY_DEG_PER_SEC.
    @Column(nullable = false)
    private double angularVelocityDegPerSec;
    //cells/segundo - abaixo disso (componente de vel ao longo do forward)
    //conta como "idle" em vez de walk/walkBackward.
    @Column(nullable = false)
    private double moveStateEpsilon;
    //cells - "raio" do corpo do player pra colisão AABB×grid.
    @Column(nullable = false)
    private double playerRadius;
    //multiplicador SEM UNIDADE aplicado a angularVelocityDegPerSec quando o
    //pawn não tem intenção de andar (move==0 — ver GameLoop.stepMovement) -
    //parado é mais fácil de mudar de direção do que correndo, então > 1.0.
    //@ColumnDefault pelo mesmo motivo do character: coluna nova NOT NULL
    //numa tabela que já tem linha quebraria o ALTER do ddl-auto=update.
    @Column(nullable = false)
    @ColumnDefault("1.5")
    private double idleTurnMultiplier;

    protected PlayerControllerSettings() {
        //JPA
    }

    public PlayerControllerSettings(long id, String character, double moveSpeedForward, double moveSpeedBackward,
            double accel, double angularVelocityDegPerSec, double moveStateEpsilon, double playerRadius,
            double idleTurnMultiplier) {
        this.id = id;
        this.character = character;
        this.moveSpeedForward = moveSpeedForward;
        this.moveSpeedBackward = moveSpeedBackward;
        this.accel = accel;
        this.angularVelocityDegPerSec = angularVelocityDegPerSec;
        this.moveStateEpsilon = moveStateEpsilon;
        this.playerRadius = playerRadius;
        this.idleTurnMultiplier = idleTurnMultiplier;
    }

    public long getId() { return id; }
    public String getCharacter() { return character; }
    public double getMoveSpeedForward() { return moveSpeedForward; }
    public double getMoveSpeedBackward() { return moveSpeedBackward; }
    public double getAccel() { return accel; }
    public double getAngularVelocityDegPerSec() { return angularVelocityDegPerSec; }
    public double getMoveStateEpsilon() { return moveStateEpsilon; }
    public double getPlayerRadius() { return playerRadius; }
    public double getIdleTurnMultiplier() { return idleTurnMultiplier; }
}
