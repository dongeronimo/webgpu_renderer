package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/** O par do spawn: a entidade deixa de existir. Client destrói o Node e esquece o id. */
public record Despawn(List<Long> ids) implements ServerMessage {}
