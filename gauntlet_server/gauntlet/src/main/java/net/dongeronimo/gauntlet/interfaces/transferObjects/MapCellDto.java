package net.dongeronimo.gauntlet.interfaces.transferObjects;

import java.util.Map;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Uma célula no fio. SEM x/z: a lista do MapSync é row-major, então o ÍNDICE já
 * é a posição (i = z*w + x) — mandar x/z em 1024 células só engordaria o
 * payload com o que o client deriva de graça.
 *
 * `category` viaja junto com `type` de propósito, mesmo sendo derivável dele no
 * server: é a categoria que o client usa pra colisão, então um tipo NOVO que
 * este client ainda não conhece continua colidindo (ou não) certo, em vez de
 * virar buraco no mundo. `extras` é o kv livre — vazio não vai no fio
 * (NON_EMPTY), senão seriam ~1000 `"extras":{}` por mapSync.
 */
@JsonInclude(JsonInclude.Include.NON_EMPTY)
public record MapCellDto(String category, String type, Map<String, String> extras) {}
