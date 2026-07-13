package net.dongeronimo.gauntlet.interfaces.transferObjects;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Espelho do ClientMessage: a família do que o server ESCREVE. O server nunca
 * deserializa isso — quem lê é o TS no browser. As anotações servem pra
 * escrita: o Jackson acrescenta o "operation" sozinho a partir do nome
 * registrado no JsonSubTypes.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "operation")
@JsonSubTypes({ @JsonSubTypes.Type(value = JoinResponse.class, name = "join") })
public sealed interface ServerMessage permits JoinResponse {}
