package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Só o que muda a 20 Hz. kind/owner já foram no spawn/stateSync — o id basta
 * pro client achar o Node no registry dele. vx/vz (células/s, velocidade
 * CORRENTE pós-suavização — ver GameLoop.stepMovement) viajam pro client
 * fazer dead reckoning dos remotos entre snapshots. ack = último seq de input
 * processado deste pawn — o dono usa pra reconciliar a predição (compara no
 * MESMO seq, corrige só a misprediction, não o atraso); os outros ignoram.
 */
public record SnapEntity(long id, double x, double z, double yaw, double vx, double vz, String state, long ack) {}
