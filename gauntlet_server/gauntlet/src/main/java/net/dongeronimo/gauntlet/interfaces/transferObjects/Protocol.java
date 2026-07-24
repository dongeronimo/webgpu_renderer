package net.dongeronimo.gauntlet.interfaces.transferObjects;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Versão do protocolo de rede. INCREMENTAR a cada mudança em qualquer mensagem
 * (client→server ou server→client). O client tem o espelho em
 * src/gauntlet/protocol.ts (PROTOCOL_VERSION) — os dois têm que subir JUNTOS
 * (deploy.py all).
 *
 * Regra: toda mensagem carrega 'protocolVersion'. O SERVER ignora mensagem de
 * versão ABAIXO da dele (client velho não afeta server novo); o CLIENT explode
 * se receber mensagem abaixo da dele (server velho = client à frente — falha
 * alto em vez de agir com dado incompatível). O campo é injetado/checado aqui,
 * no encode/decode, pra nenhuma mensagem nova esquecer dele.
 */
public final class Protocol {
    public static final long VERSION = 1;

    private Protocol() {}

    /** Serializa a mensagem já com o protocolVersion — toda saída ganha o campo. */
    public static String encode(ObjectMapper mapper, Object message) {
        ObjectNode node = (ObjectNode) mapper.valueToTree(message);
        node.put("protocolVersion", VERSION);
        return mapper.writeValueAsString(node);
    }

    /** Desserializa se a versão for >= a nossa; abaixo disso devolve null (o
     *  server IGNORA mensagem de protocolo antigo). Malformado propaga a
     *  JacksonException pro caller tratar como já trata. */
    public static <T> T decode(ObjectMapper mapper, String payload, Class<T> type) {
        JsonNode node = mapper.readTree(payload);
        if (node.path("protocolVersion").asLong() < VERSION) {
            return null;
        }
        if (node instanceof ObjectNode obj) {
            obj.remove("protocolVersion"); //não é componente dos records — tira antes do bind
        }
        return mapper.treeToValue(node, type);
    }
}
