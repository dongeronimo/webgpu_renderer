package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Só o que muda a 20 Hz. kind/owner já foram no spawn/stateSync — o id basta
 * pro client achar o Node no registry dele. vx/vz (células/s, velocidade
 * CORRENTE pós-suavização — ver GameLoop.stepMovement) viajam pro client
 * fazer dead reckoning dos remotos entre snapshots.
 */
public record SnapEntity(long id, double x, double z, double yaw, double vx, double vz) {}
