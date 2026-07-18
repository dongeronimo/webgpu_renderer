package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/**
 * O full sync do join-in-progress: spawn em massa de TUDO que está vivo.
 * Quando o semi-estático existir (portas/chaves/loot, 1c), ele entra aqui
 * também — é a foto completa do mundo no tick da chegada.
 */
public record StateSync(List<EntityDto> ents) implements ServerMessage {}
