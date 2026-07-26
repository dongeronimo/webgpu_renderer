package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.List;

/**
 * O estado ESTÁTICO como DADO (nunca seed — não existe procgen compartilhado):
 * a descrição de CADA célula do grid, row-major (cells[z*w + x]), com w*h
 * entradas sempre. 1× no join; repete só em "novo andar" (futuro).
 *
 * Era uma string por linha de tiles, legível no DevTools. Trocado porque um
 * char por célula não descreve célula nenhuma: tudo que não coubesse nele
 * (spawn, saída, seed de grama) virava campo paralelo no protocolo. A leitura
 * a olho continua existindo, do lado de cá em GameMap.toRows() (log/teste) e
 * do lado do client em GauntletMap.toRows().
 */
public record MapSync(int w, int h, List<MapCellDto> cells) implements ServerMessage {}
