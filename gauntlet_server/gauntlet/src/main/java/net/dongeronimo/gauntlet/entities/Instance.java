package net.dongeronimo.gauntlet.entities;

import java.util.ArrayList;
import java.util.List;

/**
 * Uma instance é a partida. Lembrando que o jogo é server-autoritativo!
 * Uma instância surge quando um player tenta entrar no jogo depois de passar
 * pelo login e entrar no /signaling websocket. 
 */
public class Instance {
    private long id;
    private List<Player> players;

    public Instance(){

    }
    public Instance(long id) {
        this.id = id;
    }
    
    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public List<Player> getPlayers() {
        return players;
    }

    public int getPlayerCount() {
        if(players == null)
            return 0;
        else
            return players.size();
    }

    public void setPlayers(List<Player> players) {
        this.players = players;
    }

    public void AddPlayer(Player p) {
        if(players == null)
            players = new ArrayList<>();
        players.add(p);
    }
}
