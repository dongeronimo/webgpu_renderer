package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/**
 * O estado ESTÁTICO como DADO (nunca seed — não existe procgen compartilhado):
 * uma string por linha de tiles, estilo roguelike, legível no DevTools.
 * 1× no join; repete só em "novo andar" (futuro).
 */
public record MapSync(int w, int h, List<String> rows) implements ServerMessage {}
