package net.dongeronimo.gauntlet.interfaces.transferObjects;

//{"operation":"join","character":"Dmitry"} — character é a escolha feita no
//modal pós-login (client), validada contra PlayerControllerSettingsPersistence
//em SignalingWS antes de gravar em Player e entrar na instância.
public record JoinRequest(String character) implements ClientMessage {}