package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Intenção de movimento, mandada a 20 Hz SEMPRE (mesmo sem mudança — o
 * server usa a última recebida como intenção corrente; ver Instance.intents).
 * Controles relativos à orientação atual (tipo tank control): turn = giro
 * (A=+1/D=-1), move = andar na direção que o pawn está olhando (W=+1/S=-1).
 * Cada um em [-1,1]; seq viaja mas é ignorado na fase 1 — é o pré-requisito
 * da prediction da fase 2.
 */
public record Input(long seq, double turn, double move) implements ClientMessage {}
