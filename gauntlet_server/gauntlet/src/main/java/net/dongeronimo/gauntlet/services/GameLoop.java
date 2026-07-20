package net.dongeronimo.gauntlet.services;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import net.dongeronimo.gauntlet.entities.GameMap;
import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.InstanceEvent;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.entities.WorldEntity;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Despawn;
import net.dongeronimo.gauntlet.interfaces.transferObjects.EntityDto;
import net.dongeronimo.gauntlet.interfaces.transferObjects.MapSync;
import net.dongeronimo.gauntlet.interfaces.transferObjects.ServerMessage;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Snap;
import net.dongeronimo.gauntlet.interfaces.transferObjects.SnapEntity;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Spawn;
import net.dongeronimo.gauntlet.interfaces.transferObjects.StateSync;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Welcome;
import tools.jackson.databind.ObjectMapper;

/**
 * O "Update loop" do server. Cada instância agenda seu tick de 50 ms no
 * executor compartilhado; TODO o estado de mundo é lido/escrito só daqui
 * (single-writer). As threads de IO nunca chamam nada daqui — elas só
 * enfileiram InstanceEvent na instância.
 */
@Component
public class GameLoop {
    public static final int TICK_RATE = 20;
    public static final long TICK_MILLIS = 1000 / TICK_RATE;
    private static final double DT_SECONDS = TICK_MILLIS / 1000.0;
    //cells/segundo (1 cell = 1 unidade) — velocidade de cruzeiro; a
    //aceleração (ACCEL) é quem decide quão rápido se chega lá. Ajuste de
    //sensação: só mexer aqui.
    private static final double MOVE_SPEED = 3.0;
    //cells/segundo² — o quanto a velocidade CORRENTE anda por tick rumo à
    //intenção, em vez de saltar direto pra ela. É isso que dá ângulos
    //intermediários numa virada (o vetor desliza entre as 8 direções em vez
    //de trocar instantâneo) e uma parada suave em vez de travar seco.
    //MOVE_SPEED/ACCEL = ~0.15s pra sair do zero até a velocidade máxima.
    private static final double ACCEL = 20.0;
    //graus/segundo — o quanto o yaw pode girar por tick rumo ao alvo. Um giro
    //de 180° (ex.: <- pra ->) leva TURN_180_MS. Desacoplado da velocidade de
    //propósito (ver stepMovement): se fosse atan2(vel), o ângulo fica PRESO
    //na direção antiga enquanto a velocidade só desacelera (nunca muda de
    //direção até cruzar zero) e aí salta instantâneo pro oposto — era o bug.
    private static final double TURN_RATE_RAD_PER_SEC = Math.toRadians(540.0);
    //"raio" do corpo do player pra colisão AABB×grid, em cells.
    private static final double PLAYER_RADIUS = 0.3;
    //cells/segundo — abaixo disso conta como "idle" mesmo com resíduo de
    //velocidade (ex.: freando até parar). Só decide idle/walk; não é o
    //mesmo epsilon do "praticamente zero" usado pra pular a resolução de
    //colisão logo abaixo (esse é bem mais apertado, 1e-6).
    private static final double MOVE_STATE_EPSILON = 0.05;
    private static final double[] ZERO_INTENT = {0.0, 0.0};
    private static final double[] ZERO_VELOCITY = {0.0, 0.0};

    private final ObjectMapper objectMapper;
    private final ScheduledExecutorService executor;

    public GameLoop(ObjectMapper objectMapper, ScheduledExecutorService gameLoopExecutor) {
        this.objectMapper = objectMapper;
        this.executor = gameLoopExecutor;
    }

    /** Chamado pelo InstanceService quando a instância nasce (sob o lock dele). */
    public void start(Instance instance) {
        instance.setTickHandle(executor.scheduleAtFixedRate(
            () -> safeTick(instance), 0, TICK_MILLIS, TimeUnit.MILLISECONDS));
    }

    /** Chamado pelo InstanceService quando o último player sai (sob o lock dele). */
    public void stop(Instance instance) {
        instance.setState(Instance.State.CLOSING);
        if (instance.getTickHandle() != null) {
            //cancel(false): um tick EM VOO termina em paz; só não existe próximo.
            instance.getTickHandle().cancel(false);
        }
        instance.setState(Instance.State.DEAD);
    }

    /**
     * Pega-tudo OBRIGATÓRIO: exceção que escapa de uma task periódica cancela
     * o scheduleAtFixedRate silenciosamente — a instância congelaria sem log
     * nenhum. Throwable de propósito (Error também mataria o tick).
     */
    private void safeTick(Instance instance) {
        try {
            tick(instance);
        } catch (Throwable t) {
            System.out.println("tick da instância " + instance.getId() + " explodiu: " + t);
            t.printStackTrace();
        }
    }

    /** Um passo de simulação. Package-private pro teste tickar na mão, sem executor. */
    void tick(Instance instance) {
        //O tick avança ANTES de processar: welcome e o primeiro snap da sessão
        //saem com o MESMO número — o corte consistente do mundo no tick N.
        instance.setTick(instance.getTick() + 1);

        //1) drena a caixa de entrada (membership agora; input entra aqui no 1a)
        InstanceEvent event;
        while ((event = instance.pollEvent()) != null) {
            switch (event) {
                case InstanceEvent.PlayerArrived(Player player, WebSocketSession session) ->
                    onPlayerArrived(instance, player, session);
                case InstanceEvent.PlayerLeft(Player player) ->
                    onPlayerLeft(instance, player);
                case InstanceEvent.PlayerInput(Player player, double dx, double dz, long seq) ->
                    onPlayerInput(instance, player, dx, dz);
            }
        }

        //2) simular dt=50ms fixo: 8 direções, sem inércia (spec "Movimento da
        //fase 1"), colisão AABB×grid resolvida aqui.
        stepMovement(instance);

        //3) snapshot completo pra toda sessão da instância
        broadcastSnap(instance);
    }

    /** Resolve playerId→pawn UMA vez aqui; o passo de movimento só lê o Map. */
    private void onPlayerInput(Instance instance, Player player, double dx, double dz) {
        instance.getWorld().values().stream()
            .filter(e -> "player".equals(e.getKind()) && e.getOwner() == player.getId())
            .findFirst()
            .ifPresent(pawn -> instance.getIntents().put(pawn.getId(), new double[]{dx, dz}));
    }

    /**
     * Move cada pawn: a velocidade CORRENTE (persistida em Instance.velocities)
     * desliza por aceleração até a intenção normalizada×MOVE_SPEED, em vez de
     * saltar direto pra lá — dá ângulos intermediários numa virada (o vetor
     * passa por eles a caminho do alvo) e uma parada suave. Eixo a eixo (não
     * all-or-nothing): permite deslizar na parede em vez de travar de vez
     * quando o vetor não é puramente ortogonal a ela.
     */
    private void stepMovement(Instance instance) {
        GameMap map = instance.getMap();
        for (WorldEntity e : instance.getWorld().values()) {
            if (!"player".equals(e.getKind()))
                continue;
            double[] intent = instance.getIntents().getOrDefault(e.getId(), ZERO_INTENT);
            double mag = Math.hypot(intent[0], intent[1]);
            double targetVx = 0.0;
            double targetVz = 0.0;
            if (mag > 1e-6) {
                targetVx = intent[0] / mag * MOVE_SPEED; //normaliza: diagonal não anda mais rápido
                targetVz = intent[1] / mag * MOVE_SPEED;
                //Yaw derivado do INPUT (não da velocidade) e girado a taxa
                //limitada rumo ao alvo — desacoplado de vel de propósito: já
                //começa a virar mesmo ainda freando da direção anterior, em
                //vez de ficar preso no ângulo antigo até vel cruzar zero e aí
                //saltar instantâneo pro oposto (era o bug do <- pra ->).
                //Parado (sem intent): yaw não muda (Gauntlet não vira parado).
                double targetYaw = Math.atan2(intent[0], intent[1]);
                e.setYaw(rotateToward(e.getYaw(), targetYaw, TURN_RATE_RAD_PER_SEC * DT_SECONDS));
            }

            double[] vel = instance.getVelocities().computeIfAbsent(e.getId(), id -> new double[] { 0.0, 0.0 });
            double maxDelta = ACCEL * DT_SECONDS;
            vel[0] = moveToward(vel[0], targetVx, maxDelta);
            vel[1] = moveToward(vel[1], targetVz, maxDelta);

            double speed = Math.hypot(vel[0], vel[1]);
            //Movimento é a ÚNICA coisa que decide idle/walk hoje, então dá pra
            //recalcular toda tick sem medo — mas isto SETA e.state (não deriva
            //só na hora de montar o DTO): quando existir um state que não vem
            //do movimento (ex.: "dead", setado por um sistema de dano), este
            //trecho não pode continuar pisando em cima dele sem checar antes.
            e.setState(speed > MOVE_STATE_EPSILON ? "walk" : "idle");
            if (speed < 1e-6)
                continue;

            double newX = e.getX() + vel[0] * DT_SECONDS;
            double newZ = e.getZ() + vel[1] * DT_SECONDS;
            //bateu na parede nesse eixo: zera a velocidade DO EIXO, senão ela
            //fica "empurrando" a parede e o próximo tick não acelera de novo.
            if (isFree(map, newX, e.getZ()))
                e.setX(newX);
            else
                vel[0] = 0.0;
            if (isFree(map, e.getX(), newZ))
                e.setZ(newZ);
            else
                vel[1] = 0.0;
        }
    }

    /** Anda `current` até `target`, no máximo `maxDelta` por chamada. */
    private double moveToward(double current, double target, double maxDelta) {
        double diff = target - current;
        if (Math.abs(diff) <= maxDelta)
            return target;
        return current + Math.signum(diff) * maxDelta;
    }

    /** Gira `currentRad` rumo a `targetRad` pelo caminho mais curto, no
     *  máximo `maxDeltaRad` por chamada — o análogo angular do moveToward. */
    private double rotateToward(double currentRad, double targetRad, double maxDeltaRad) {
        double diff = normalizeAngle(targetRad - currentRad);
        if (Math.abs(diff) <= maxDeltaRad)
            return normalizeAngle(targetRad);
        return normalizeAngle(currentRad + Math.signum(diff) * maxDeltaRad);
    }

    /** Traz um ângulo em radianos pra (-PI, PI] — necessário pro caminho
     *  mais curto do rotateToward não girar pelo lado errado perto da
     *  costura -180/180. */
    private double normalizeAngle(double rad) {
        double twoPi = 2 * Math.PI;
        double a = rad % twoPi;
        if (a <= -Math.PI)
            a += twoPi;
        else if (a > Math.PI)
            a -= twoPi;
        return a;
    }

    /** 4 cantos do corpo (não só o centro) — não deixa cortar quina de parede. */
    private boolean isFree(GameMap map, double x, double z) {
        return map.isWalkable(cellOf(x - PLAYER_RADIUS), cellOf(z - PLAYER_RADIUS))
            && map.isWalkable(cellOf(x + PLAYER_RADIUS), cellOf(z - PLAYER_RADIUS))
            && map.isWalkable(cellOf(x - PLAYER_RADIUS), cellOf(z + PLAYER_RADIUS))
            && map.isWalkable(cellOf(x + PLAYER_RADIUS), cellOf(z + PLAYER_RADIUS));
    }

    private int cellOf(double coord) {
        return (int) Math.floor(coord);
    }

    /**
     * A "presença" de verdade: aqui o player passa a existir no mundo. Nasce o
     * pawn, e a sessão recebe o full sync na ordem garantida da spec:
     * welcome → mapSync → stateSync (tudo antes do primeiro snap dela).
     */
    private void onPlayerArrived(Instance instance, Player player, WebSocketSession session) {
        GameMap map = instance.getMap();
        List<GameMap.Cell> spawns = map.getPlayerSpawns();
        GameMap.Cell cell = spawns.get(instance.getSessions().size() % spawns.size());

        WorldEntity pawn = new WorldEntity(instance.nextEntityId(), "player", player.getId(),
            cell.x() + 0.5, cell.z() + 0.5, 0.0); //+0.5 = centro da célula (tile = 1 unidade)
        instance.getWorld().put(pawn.getId(), pawn);
        instance.getSessions().put(player.getId(), session);

        send(session, new Welcome(pawn.getId(), instance.getId(), TICK_RATE, instance.getTick()));
        send(session, new MapSync(map.getWidth(), map.getHeight(), map.toRows()));
        send(session, new StateSync(instance.getWorld().values().stream().map(this::toDto).toList()));

        //o novato já se recebeu no stateSync; spawn é só pros VETERANOS
        broadcastExcept(instance, player.getId(), new Spawn(List.of(toDto(pawn))));
        System.out.println("instância " + instance.getId() + ": " + player.getName()
            + " entrou no mundo como entidade " + pawn.getId());
    }

    private void onPlayerLeft(Instance instance, Player player) {
        instance.getSessions().remove(player.getId());
        Optional<WorldEntity> pawn = instance.getWorld().values().stream()
            .filter(e -> "player".equals(e.getKind()) && e.getOwner() == player.getId())
            .findFirst();
        if (pawn.isEmpty())
            return; //reservou vaga mas nunca conectou o socket de jogo
        instance.getWorld().remove(pawn.get().getId());
        broadcast(instance, new Despawn(List.of(pawn.get().getId())));
    }

    private void broadcastSnap(Instance instance) {
        if (instance.getSessions().isEmpty())
            return;
        List<SnapEntity> ents = instance.getWorld().values().stream()
            .map(e -> {
                double[] vel = instance.getVelocities().getOrDefault(e.getId(), ZERO_VELOCITY);
                return new SnapEntity(e.getId(), e.getX(), e.getZ(), e.getYaw(), vel[0], vel[1], e.getState());
            })
            .toList();
        broadcast(instance, new Snap(instance.getTick(), ents));
    }

    /** Serializa UMA vez e manda a mesma string pra todo mundo. */
    private void broadcast(Instance instance, ServerMessage message) {
        TextMessage text = new TextMessage(objectMapper.writeValueAsString(message));
        for (WebSocketSession session : instance.getSessions().values()) {
            trySend(session, text);
        }
    }

    private void broadcastExcept(Instance instance, long exceptPlayerId, ServerMessage message) {
        TextMessage text = new TextMessage(objectMapper.writeValueAsString(message));
        for (Map.Entry<Long, WebSocketSession> entry : instance.getSessions().entrySet()) {
            if (entry.getKey() != exceptPlayerId) {
                trySend(entry.getValue(), text);
            }
        }
    }

    private void send(WebSocketSession session, ServerMessage message) {
        trySend(session, new TextMessage(objectMapper.writeValueAsString(message)));
    }

    /**
     * Sessão pode morrer entre o isOpen e o send — loga e segue: o
     * afterConnectionClosed do socket vai enfileirar o PlayerLeft que limpa.
     */
    private void trySend(WebSocketSession session, TextMessage text) {
        try {
            session.sendMessage(text);
        } catch (Exception e) {
            System.out.println("send falhou (sessão " + session.getId() + "): " + e);
        }
    }

    private EntityDto toDto(WorldEntity e) {
        return new EntityDto(e.getId(), e.getKind(), e.getOwner(), e.getX(), e.getZ(), e.getYaw(), e.getState());
    }
}
