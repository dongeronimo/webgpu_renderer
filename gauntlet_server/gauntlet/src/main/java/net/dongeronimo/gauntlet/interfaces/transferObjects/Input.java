package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Intenção de movimento, mandada a 20 Hz SEMPRE (mesmo sem mudança — o
 * server usa a última recebida como intenção corrente; ver Instance.intents).
 * dx/dz são eixos crus (tipicamente em [-1,1] cada; combinações tipo WASD
 * diagonal dão magnitude >1), o server normaliza antes de mover. seq viaja
 * mas é ignorado na fase 1 — é o pré-requisito da prediction da fase 2.
 */
public record Input(long seq, double dx, double dz) implements ClientMessage {}
