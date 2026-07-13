package net.dongeronimo.gauntlet.interfaces.transferObjects;

/**
 * Long e não long de propósito: na recusa (alreadyInGame) não existe instância
 * e o JSON sai "instanceId":null — explícito e legível, no espírito da fase
 * texto do protocolo.
 */
public record JoinResponse(String result, Long instanceId) implements ServerMessage {}
