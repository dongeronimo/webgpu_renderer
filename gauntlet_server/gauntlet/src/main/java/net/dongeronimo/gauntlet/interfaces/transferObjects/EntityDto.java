package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Retrato COMPLETO de uma entidade — o shape que vai no spawn e no stateSync,
 * onde o client precisa de tudo pra instanciar o prefab certo (hoje
 * character→prefab é 1:1, o nome já bate com a chave do Map de prefabs do
 * client — ver GauntletNetwork.onEntsAdded). O snap NÃO usa isto: lá vai só
 * o que muda a 20 Hz (SnapEntity).
 */
public record EntityDto(long id, String kind, String character, long owner, double x, double z, double yaw, String state) {}
