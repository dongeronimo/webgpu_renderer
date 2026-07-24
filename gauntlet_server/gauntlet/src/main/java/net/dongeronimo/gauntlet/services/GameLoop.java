package net.dongeronimo.gauntlet.services;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import net.dongeronimo.gauntlet.entities.GameMap;
import net.dongeronimo.gauntlet.entities.Instance;
import net.dongeronimo.gauntlet.entities.InstanceEvent;
import net.dongeronimo.gauntlet.entities.Player;
import net.dongeronimo.gauntlet.entities.PlayerControllerSettings;
import net.dongeronimo.gauntlet.entities.WorldEntity;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Despawn;
import net.dongeronimo.gauntlet.interfaces.transferObjects.EntityDto;
import net.dongeronimo.gauntlet.interfaces.transferObjects.MapSync;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Protocol;
import net.dongeronimo.gauntlet.interfaces.transferObjects.ServerMessage;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Snap;
import net.dongeronimo.gauntlet.interfaces.transferObjects.SnapEntity;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Spawn;
import net.dongeronimo.gauntlet.interfaces.transferObjects.StateSync;
import net.dongeronimo.gauntlet.interfaces.transferObjects.Welcome;
import net.dongeronimo.gauntlet.persistence.PlayerControllerSettingsPersistence;
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
    //Os parâmetros de movimento vêm de PlayerControllerSettings (tabela
    //player_controller_settings) — UMA linha por personagem agora (Dmitry
    //mais lento/robusto, Nat mais rápida/ágil — ver
    //PlayerControllerSettingsPersistence.defaults()), lidas UMA VEZ no boot e
    //indexadas por character aqui. Editar as linhas no /h2-console e
    //reiniciar o server pra valer (sem hot-reload/REST por ora).
    private final Map<String, Movement> movementByCharacter;
    //cells/segundo — abaixo disso conta como "idle" mesmo com resíduo de
    //velocidade (ex.: freando até parar). Só decide idle/walk; não é o
    //mesmo epsilon do "praticamente zero" usado pra pular a resolução de
    //colisão logo abaixo (esse é bem mais apertado, 1e-6). Fica por
    //personagem também (junto com Movement) — ver toMovement.
    private static final double[] ZERO_INTENT = {0.0, 0.0};
    private static final double[] ZERO_VELOCITY = {0.0, 0.0};

    private final ObjectMapper objectMapper;
    private final ScheduledExecutorService executor;

    public GameLoop(ObjectMapper objectMapper, ScheduledExecutorService gameLoopExecutor,
            PlayerControllerSettingsPersistence settingsPersistence) {
        this.objectMapper = objectMapper;
        this.executor = gameLoopExecutor;
        this.movementByCharacter = settingsPersistence.getAll().values().stream()
            .collect(Collectors.toUnmodifiableMap(PlayerControllerSettings::getCharacter, GameLoop::toMovement));
    }

    /** Parâmetros de movimento JÁ CONVERTIDOS (giro em radianos) de UM
     *  personagem — copiados de PlayerControllerSettings uma vez no boot, não
     *  lidos de novo tick a tick (a linha do banco continua em graus, mais
     *  fácil de editar a olho no /h2-console; ver
     *  MineAvatarBehaviour.ANGULAR_VELOCITY_DEG_PER_SEC pro espelho client). */
    private record Movement(double speedForward, double speedBackward, double accel,
            double angularVelocityRadPerSec, double stateEpsilon, double radius, double idleTurnMultiplier) {}

    private static Movement toMovement(PlayerControllerSettings s) {
        return new Movement(s.getMoveSpeedForward(), s.getMoveSpeedBackward(), s.getAccel(),
            Math.toRadians(s.getAngularVelocityDegPerSec()), s.getMoveStateEpsilon(), s.getPlayerRadius(),
            s.getIdleTurnMultiplier());
    }

    /** @throws IllegalStateException se `character` não tiver Movement — só
     *  pode acontecer se um WorldEntity nascer com um character que não bate
     *  com nenhuma linha da tabela (SignalingWS já valida antes do join, ver
     *  PlayerControllerSettingsPersistence.isKnownCharacter). */
    private Movement movementOf(WorldEntity e) {
        Movement m = movementByCharacter.get(e.getCharacter());
        if (m == null) {
            throw new IllegalStateException("GameLoop: entidade " + e.getId()
                + " com character desconhecido: " + e.getCharacter());
        }
        return m;
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
                case InstanceEvent.PlayerInput(Player player, double turn, double move, long seq) ->
                    onPlayerInput(instance, player, turn, move, seq);
            }
        }

        //2) simular dt=50ms fixo: 8 direções, sem inércia (spec "Movimento da
        //fase 1"), colisão AABB×grid resolvida aqui.
        stepMovement(instance);

        //3) snapshot completo pra toda sessão da instância
        broadcastSnap(instance);
    }

    /** Resolve playerId→pawn UMA vez aqui; o passo de movimento só lê o Map. */
    private void onPlayerInput(Instance instance, Player player, double turn, double move, long seq) {
        instance.getWorld().values().stream()
            .filter(e -> "player".equals(e.getKind()) && e.getOwner() == player.getId())
            .findFirst()
            .ifPresent(pawn -> {
                instance.getIntents().put(pawn.getId(), new double[]{turn, move});
                //guarda o seq pro ack do snap — é o que o client usa pra
                //reconciliar comparando no MESMO seq (ver SnapEntity.ack).
                instance.getLastInputSeq().put(pawn.getId(), seq);
            });
    }

    /**
     * Move cada pawn com controle tipo "tank": turn gira o yaw a ritmo
     * constante (funciona parado, independente de estar andando), move anda
     * na direção que o pawn ESTÁ olhando (não na direção do input bruto). A
     * velocidade CORRENTE (persistida em Instance.velocities) desliza por
     * aceleração até o alvo, em vez de saltar direto pra lá — dá uma
     * freada/partida suave. Eixo a eixo (não all-or-nothing): permite
     * deslizar na parede em vez de travar de vez quando o vetor não é
     * puramente ortogonal a ela.
     */
    private void stepMovement(Instance instance) {
        GameMap map = instance.getMap();
        for (WorldEntity e : instance.getWorld().values()) {
            if (!"player".equals(e.getKind()))
                continue;
            Movement movement = movementOf(e);
            double[] intent = instance.getIntents().getOrDefault(e.getId(), ZERO_INTENT);
            double turn = intent[0];
            double move = intent[1];

            //Yaw é ESTADO PERSISTENTE agora (não mais derivado do input a
            //cada tick): A/D giram a ritmo constante enquanto seguradas,
            //inclusive parado. Sinal de turn (A=+1/D=-1) é um CHUTE a partir
            //da convenção "dz negativo = norte" (ver MineAvatarBehaviour.ts)
            //— se A/D girarem pro lado errado na tela, inverte o sinal AQUI
            //e no client junto (mesmo cuidado do W ali).
            //Parado (move==0, SEM intenção de andar) gira mais rápido que
            //andando — mais fácil mudar de direção parado do que correndo.
            //Decide pela INTENÇÃO crua (não pela velocidade residual/e.state),
            //assim client e server concordam no mesmo tick sem depender de
            //aceleração/frenagem já ter zerado a velocidade.
            if (turn != 0.0) {
                double turnRate = move == 0.0
                    ? movement.angularVelocityRadPerSec() * movement.idleTurnMultiplier()
                    : movement.angularVelocityRadPerSec();
                e.setYaw(normalizeAngle(e.getYaw() + turn * turnRate * DT_SECONDS));
            }

            //Vetor forward a partir do yaw CORRENTE — mesma convenção do
            //antigo atan2(dx,dz)==yaw (dx=sin(yaw), dz=cos(yaw)), só que agora
            //indo do ângulo pro vetor em vez do vetor pro ângulo. W(move=+1)
            //anda nele, S(move=-1) anda no oposto, sem virar o pawn.
            double forwardX = Math.sin(e.getYaw());
            double forwardZ = Math.cos(e.getYaw());
            //move>=0 (W ou parado) usa a velocidade de frente, move<0 (S) usa
            //a de trás (mais lenta) — o sinal de move já entra na conta
            //abaixo, então só a MAGNITUDE muda aqui.
            double moveSpeed = move >= 0.0 ? movement.speedForward() : movement.speedBackward();
            double targetVx = forwardX * move * moveSpeed;
            double targetVz = forwardZ * move * moveSpeed;

            double[] vel = instance.getVelocities().computeIfAbsent(e.getId(), id -> new double[] { 0.0, 0.0 });
            double maxDelta = movement.accel() * DT_SECONDS;
            vel[0] = moveToward(vel[0], targetVx, maxDelta);
            vel[1] = moveToward(vel[1], targetVz, maxDelta);

            //Componente da velocidade AO LONGO do forward atual (com sinal):
            //>0 andando pra frente, <0 pra trás — decide walk/walkBackward.
            //Movimento é a ÚNICA coisa que decide isto hoje, então dá pra
            //recalcular toda tick sem medo — mas isto SETA e.state (não
            //deriva só na hora de montar o DTO): quando existir um state que
            //não vem do movimento (ex.: "dead", setado por um sistema de
            //dano), este trecho não pode continuar pisando em cima dele sem
            //checar antes.
            double forwardSpeed = vel[0] * forwardX + vel[1] * forwardZ;
            if (forwardSpeed > movement.stateEpsilon())
                e.setState("walk");
            else if (forwardSpeed < -movement.stateEpsilon())
                e.setState("walkBackward");
            else
                e.setState("idle");

            double speed = Math.hypot(vel[0], vel[1]);
            if (speed < 1e-6)
                continue;

            double newX = e.getX() + vel[0] * DT_SECONDS;
            double newZ = e.getZ() + vel[1] * DT_SECONDS;
            //bateu na parede nesse eixo: zera a velocidade DO EIXO, senão ela
            //fica "empurrando" a parede e o próximo tick não acelera de novo.
            if (isFree(map, newX, e.getZ(), movement.radius()))
                e.setX(newX);
            else
                vel[0] = 0.0;
            if (isFree(map, e.getX(), newZ, movement.radius()))
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

    /** 4 cantos do corpo (não só o centro) — não deixa cortar quina de parede.
     *  `radius` é do PERSONAGEM da entidade (Movement.radius), não mais uma
     *  constante global — Dmitry/Nat podem ter raios diferentes. */
    private boolean isFree(GameMap map, double x, double z, double radius) {
        return map.isWalkable(cellOf(x - radius), cellOf(z - radius))
            && map.isWalkable(cellOf(x + radius), cellOf(z - radius))
            && map.isWalkable(cellOf(x - radius), cellOf(z + radius))
            && map.isWalkable(cellOf(x + radius), cellOf(z + radius));
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

        //character SEMPRE presente aqui: SignalingWS grava a escolha do
        //JoinRequest em Player antes de qualquer socket de jogo abrir (ver
        //SignalingWS.handleTextMessage) — orElseThrow em vez de fallback
        //silencioso, pra um bug de ordering quebrar alto em vez de spawnar
        //um pawn com Movement de personagem errado.
        String character = player.getCharacter().orElseThrow(
            () -> new IllegalStateException("onPlayerArrived: " + player.getName() + " sem character — join não gravou a escolha?"));
        WorldEntity pawn = new WorldEntity(instance.nextEntityId(), "player", character, player.getId(),
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
                return new SnapEntity(e.getId(), e.getX(), e.getZ(), e.getYaw(), vel[0], vel[1], e.getState(),
                    instance.getLastInputSeq().getOrDefault(e.getId(), 0L));
            })
            .toList();
        broadcast(instance, new Snap(instance.getTick(), ents));
    }

    /** Serializa UMA vez e manda a mesma string pra todo mundo. */
    private void broadcast(Instance instance, ServerMessage message) {
        TextMessage text = new TextMessage(Protocol.encode(objectMapper, message));
        for (WebSocketSession session : instance.getSessions().values()) {
            trySend(session, text);
        }
    }

    private void broadcastExcept(Instance instance, long exceptPlayerId, ServerMessage message) {
        TextMessage text = new TextMessage(Protocol.encode(objectMapper, message));
        for (Map.Entry<Long, WebSocketSession> entry : instance.getSessions().entrySet()) {
            if (entry.getKey() != exceptPlayerId) {
                trySend(entry.getValue(), text);
            }
        }
    }

    private void send(WebSocketSession session, ServerMessage message) {
        trySend(session, new TextMessage(Protocol.encode(objectMapper, message)));
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
        return new EntityDto(e.getId(), e.getKind(), e.getCharacter(), e.getOwner(), e.getX(), e.getZ(), e.getYaw(), e.getState());
    }
}
