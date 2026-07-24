package net.dongeronimo.gauntlet.entities;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ScheduledFuture;

import org.springframework.web.socket.WebSocketSession;

/**
 * Uma instance é a partida. Lembrando que o jogo é server-autoritativo!
 * Uma instância surge quando um player tenta entrar no jogo depois de passar
 * pelo login e entrar no /signaling websocket.
 *
 * Regra de threading, campo a campo:
 * - inbox: QUALQUER thread escreve (fila concorrente), só a game thread lê;
 * - state/tickHandle/players: só sob o lock do InstanceService;
 * - tick/world/sessions/nextEntityId: SÓ a game thread (single-writer).
 */
public class Instance {
    /** RUNNING→CLOSING→DEAD. Join só seleciona RUNNING. */
    public enum State { RUNNING, CLOSING, DEAD }

    private long id;
    private List<Player> players;
    /** O mundo estático da partida. Nasce junto com a instância, no create. */
    private GameMap map;
    private State state = State.RUNNING;

    /** Caixa de entrada da game thread: IO enfileira, tick drena. */
    private final ConcurrentLinkedQueue<InstanceEvent> inbox = new ConcurrentLinkedQueue<>();
    /** Pra cancelar o tick no destroy — esquecer = instância morta tickando pra sempre. */
    private ScheduledFuture<?> tickHandle;

    /** O relógio da partida: quantos ticks já rodaram. */
    private long tick;
    /** As entidades vivas do mundo, por id de ENTIDADE. */
    private final Map<Long, WorldEntity> world = new HashMap<>();
    /** playerId (conta) → sessão do socket de JOGO (já decorada). */
    private final Map<Long, WebSocketSession> sessions = new HashMap<>();
    private long nextEntityId = 1;
    /**
     * entityId → última intenção de movimento recebida ([turn,move], eixos
     * crus e relativos à orientação atual — não mais eixos de mundo).
     * Resolvida de playerId pra entityId no drain do PlayerInput
     * (GameLoop.onPlayerInput) — o passo de movimento só lê daqui, nunca da
     * fila. Ausente = parado (nunca recebeu input, ou nunca vai receber:
     * kind != player). Só a game thread toca.
     */
    private final Map<Long, double[]> intents = new HashMap<>();
    /**
     * entityId → velocidade CORRENTE ([vx,vz], células/s), suavizada por
     * aceleração (GameLoop.stepMovement/ACCEL) em vez de saltar direto pra
     * intenção — é o que dá os ângulos intermediários na virada. Também vai
     * no Snap (SnapEntity.vx/vz) pro client fazer dead reckoning dos
     * remotos entre snapshots. Só a game thread toca.
     */
    private final Map<Long, double[]> velocities = new HashMap<>();
    /**
     * entityId → último seq de input processado (o mais recente drenado antes
     * do tick). Vai no Snap (SnapEntity.ack) pra reconciliação do client: ele
     * compara a posição do server com onde a própria predição estava NAQUELE
     * seq, corrigindo só a misprediction real (não o atraso). Só a game thread toca.
     */
    private final Map<Long, Long> lastInputSeq = new HashMap<>();

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

    public GameMap getMap() {
        return map;
    }

    public void setMap(GameMap map) {
        this.map = map;
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
    /**
     * Devolve se REALMENTE removeu — é o que torna o leave idempotente: das 3
     * portas (leave explícito, close do signaling, close do socket de jogo),
     * só a primeira que chegar age.
     */
    public boolean removePlayer(Player player) {
        return players != null && players.remove(player);
    }

    public State getState() {
        return state;
    }

    public void setState(State state) {
        this.state = state;
    }

    /** Qualquer thread de IO pode chamar; o tick drena na ordem de chegada. */
    public void enqueue(InstanceEvent event) {
        inbox.add(event);
    }

    /** Só a game thread chama. null = fila vazia. */
    public InstanceEvent pollEvent() {
        return inbox.poll();
    }

    public ScheduledFuture<?> getTickHandle() {
        return tickHandle;
    }

    public void setTickHandle(ScheduledFuture<?> tickHandle) {
        this.tickHandle = tickHandle;
    }

    public long getTick() {
        return tick;
    }

    public void setTick(long tick) {
        this.tick = tick;
    }

    public Map<Long, WorldEntity> getWorld() {
        return world;
    }

    public Map<Long, WebSocketSession> getSessions() {
        return sessions;
    }

    public Map<Long, double[]> getIntents() {
        return intents;
    }

    public Map<Long, double[]> getVelocities() {
        return velocities;
    }

    public Map<Long, Long> getLastInputSeq() {
        return lastInputSeq;
    }

    /** Ids de entidade são por instância. Só a game thread chama. */
    public long nextEntityId() {
        return nextEntityId++;
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
        Instance other = (Instance) obj;
        if (id != other.id)
            return false;
        return true;
    }
}
