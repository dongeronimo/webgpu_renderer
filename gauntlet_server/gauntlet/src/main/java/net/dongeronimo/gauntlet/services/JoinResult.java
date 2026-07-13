package net.dongeronimo.gauntlet.services;

import net.dongeronimo.gauntlet.entities.Instance;

/**
 * Os dois desfechos do joinInstance numa assinatura só. O check de "já está em
 * alguma instância" tem que acontecer DENTRO do lock do service, então o
 * método precisa poder dizer "não" sem soltar o monitor no meio.
 * ok=false → conta já está em jogo (instance vem null).
 */
public record JoinResult(boolean ok, Instance instance) {}
