package net.dongeronimo.gauntlet.entities;

import java.util.Optional;

public class Player {
    private long id;
    private String name;
    private String password;
    //é como a gente vai amarrar o player ao seu id. null = desconectado.
    //O campo é String crua; Optional é tipo de RETORNO (o getter embrulha) —
    //Optional.of(null) num setter lança NPE.
    private String websocketId;

    public Player(long id, String name, String password) {
        this.id = id;
        this.name = name;
        this.password = password;
    }
    public Player(){
    }

    public long getId() {
        return id;
    }
    public void setId(long id) {
        this.id = id;
    }
    public String getName() {
        return name;
    }
    public void setName(String name) {
        this.name = name;
    }
    public String getPassword() {
        return password;
    }
    public void setPassword(String password) {
        this.password = password;
    }
    public Optional<String> getWebsocketId() {
        return Optional.ofNullable(websocketId);
    }
    public void setWebsocketId(String websocketId) {
        this.websocketId = websocketId;
    }

}
