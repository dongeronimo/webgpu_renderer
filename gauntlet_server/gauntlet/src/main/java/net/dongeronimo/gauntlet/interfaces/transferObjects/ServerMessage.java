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
@JsonSubTypes({
    @JsonSubTypes.Type(value = JoinResponse.class, name = "join"),
    @JsonSubTypes.Type(value = Welcome.class,      name = "welcome"),
    @JsonSubTypes.Type(value = MapSync.class,      name = "mapSync"),
    @JsonSubTypes.Type(value = StateSync.class,    name = "stateSync"),
    @JsonSubTypes.Type(value = Spawn.class,        name = "spawn"),
    @JsonSubTypes.Type(value = Despawn.class,      name = "despawn"),
    @JsonSubTypes.Type(value = Snap.class,         name = "snap")
})
public sealed interface ServerMessage
    permits JoinResponse, Welcome, MapSync, StateSync, Spawn, Despawn, Snap {}
