//Espelho de PlayerControllerSettingsDto.java (GET /api/player-controller-settings/{character}).
export interface PlayerControllerSettingsDto {
    moveSpeedForward: number;
    moveSpeedBackward: number;
    accel: number;
    angularVelocityDegPerSec: number;
    moveStateEpsilon: number;
    playerRadius: number;
    idleTurnMultiplier: number;
}
