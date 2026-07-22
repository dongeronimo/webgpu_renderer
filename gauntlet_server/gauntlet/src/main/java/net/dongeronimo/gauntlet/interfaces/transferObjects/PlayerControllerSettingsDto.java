package net.dongeronimo.gauntlet.interfaces.transferObjects;

/** Resposta de GET /api/player-controller-settings/{character} — o client usa isto pra
 *  calibrar a predição local (MineAvatarBehaviour) com os MESMOS valores que
 *  o server está rodando (ver GameLoop, PlayerControllerSettings). */
public record PlayerControllerSettingsDto(
    double moveSpeedForward,
    double moveSpeedBackward,
    double accel,
    double angularVelocityDegPerSec,
    double moveStateEpsilon,
    double playerRadius,
    double idleTurnMultiplier
) {}
