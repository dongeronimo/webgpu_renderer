package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/**
 * Existência é EXPLÍCITA: entidade passa a existir quando o server manda
 * spawn, nunca por aparecer num snap (id desconhecido em snap = warn+ignora
 * no client). Garantia de ordem: spawn SEMPRE antes do primeiro snap que
 * contém a entidade.
 */
public record Spawn(List<EntityDto> ents) implements ServerMessage {}
