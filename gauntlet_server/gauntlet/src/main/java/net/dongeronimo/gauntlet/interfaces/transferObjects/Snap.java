package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/**
 * O snapshot de 20 Hz: estado dinâmico COMPLETO (sem delta), idempotente,
 * indexado pelo tick — o tick é o relógio universal que a interpolação usa.
 */
public record Snap(long tick, List<SnapEntity> ents) implements ServerMessage {}
