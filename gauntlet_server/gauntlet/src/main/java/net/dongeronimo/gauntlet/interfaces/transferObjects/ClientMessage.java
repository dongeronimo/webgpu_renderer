package net.dongeronimo.gauntlet.interfaces.transferObjects;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "operation")
@JsonSubTypes({ @JsonSubTypes.Type(value = JoinRequest.class, name = "join") })
public sealed interface ClientMessage permits JoinRequest {}
