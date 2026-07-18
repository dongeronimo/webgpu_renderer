package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Retrato COMPLETO de uma entidade — o shape que vai no spawn e no stateSync,
 * onde o client precisa de tudo pra instanciar o prefab certo (kind→prefab é
 * tabela do client). O snap NÃO usa isto: lá vai só o que muda a 20 Hz
 * (SnapEntity).
 */
public record EntityDto(long id, String kind, long owner, double x, double z, double yaw) {}
