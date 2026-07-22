package net.dongeronimo.gauntlet.entities;

import java.util.Optional;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "players")
public class Player {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private long id;
    @Column(nullable = false, unique = true)
    private String name;
    @Column(nullable = false)
    private String password;
    //é como a gente vai amarrar o player ao seu id. null = desconectado.
    //O campo é String crua; Optional é tipo de RETORNO (o getter embrulha) —
    //Optional.of(null) num setter lança NPE.
    private String websocketId;
    //Qual personagem ("Dmitry"/"Nat") o player escolheu na tela pós-login -
    //ver ModalPanel de escolha (client) e SignalingWS (grava aqui no
    //JoinRequest). null até o primeiro join; mesma convenção do
    //websocketId (Optional só no getter). Coluna "character_key" (não
    //"character") - CHARACTER é palavra reservada em SQL/H2.
    @Column(name = "character_key")
    private String character;


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
    public Optional<String> getCharacter() {
        return Optional.ofNullable(character);
    }
    public void setCharacter(String character) {
        this.character = character;
    }
    @Override
    public int hashCode() {
        final int prime = 31;
        int result = 1;
        result = prime * result + (int) (id ^ (id >>> 32));
        return result;
    }
    @Override
    public boolean equals(Object obj) {
        if (this == obj)
            return true;
        if (obj == null)
            return false;
        if (getClass() != obj.getClass())
            return false;
        Player other = (Player) obj;
        if (id != other.id)
            return false;
        return true;
    }

}
