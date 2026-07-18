package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * 1ª mensagem da sessão de jogo, 1× por sessão. Existe pelo que só ela diz:
 * id = qual entidade é VOCÊ (câmera/UI/futura prediction — ninguém mais
 * carrega essa informação); tickRate+tick = o contrato de relógio que a
 * interpolação do client persegue.
 */
public record Welcome(long id, long instanceId, int tickRate, long tick) implements ServerMessage {}
