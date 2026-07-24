package net.dongeronimo.gauntlet.interfaces.transferObjects;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "operation")
@JsonSubTypes({
    @JsonSubTypes.Type(value = JoinRequest.class, name = "join"),
    @JsonSubTypes.Type(value = Input.class,       name = "input"),
    @JsonSubTypes.Type(value = Ping.class,        name = "ping")
})
public sealed interface ClientMessage permits JoinRequest, Input, Ping {}
