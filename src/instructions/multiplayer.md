# MULTIPLAYER — modelo da fase 1

Server autoritativo em Java (Spring Boot + WebSocket cru), clients no browser.
Jogo alvo: **clone de Gauntlet** — até 4 players numa dungeon procedural,
matando monstros e coletando loot; chaves abrem caminho (estilo Doom/Duke
Nukem) e na saída tem um boss. Client = mundo `GauntletWorld` em
`src/gauntlet/` (mundo novo, não-destrutivo, como sempre).

Cada partida é uma **Instância** (seção própria abaixo). Sem lobby e sem
social na fase 1 — o único "matchmaking" é first-fit: entra na primeira
instância com vaga.

Decisão de projeto: **protocolo em TEXTO (JSON) até perto do fim.** Legível
no DevTools vale mais que bytes enquanto o jogo está nascendo. Binário é
otimização de final de projeto, com medição de bytes/s antes e depois.

---

# Os 5 princípios

1. **AUTORIDADE DO SERVER.** O server é a única verdade. O client NUNCA escreve
   estado do mundo — nem o da própria nave.
2. **INPUT, NÃO POSIÇÃO.** O client manda intenção (eixos/botões) com número de
   sequência. Na fase 1 o server ignora o `seq`, mas ele custa 4 bytes e é o
   pré-requisito da prediction da fase 2 — vai no protocolo desde já.
3. **INTERPOLAÇÃO PRA TODO MUNDO.** O client renderiza o PASSADO (~3 ticks
   atrás, ~150 ms), interpolando entre dois snapshots — inclusive a própria
   nave. Consequência assumida: seu input demora RTT + buffer pra aparecer.
   Aviso honesto: num top-down de ANDAR (sem inércia) esse delay é mais
   perceptível do que era na ideia da nave — aceito na fase 1; é exatamente
   a dor que a prediction (fase 2) cura.
   (Em termos de Unreal: na fase 1 até o seu pawn é *simulated proxy*.)
4. **FÍSICA SÓ NO SERVER.** Movimento e colisão escritos à mão em Java. O
   client não simula NADA — só interpola. Não existe código compartilhado
   (nem de física, nem de PROCGEN — ver Instâncias), logo não existe
   problema de determinismo.
5. **SNAPSHOTS A TAXA FIXA.** O server faz push do estado COMPLETO (sem delta)
   a cada tick, indexado pelo número do tick.

---

# Relógio

O **número do tick do server é o relógio universal**. Nada de wall-clock no
protocolo.

- Tick do server: **20 Hz** (dt fixo de 50 ms). Simulação avança sempre 50 ms.
- Snapshot: a cada tick (20/s) na fase 1.
- Client: mantém `renderTick` (float) que persegue `newestTick - 3`. A cada
  frame avança `renderTick +cd= dt * 20` e corrige o drift suavemente
  (`renderTick += erro * 0.05`; se |erro| > 10 ticks, snap direto).
- Interpolação: acha os snapshots `s0`, `s1` com `s0.tick <= renderTick <=
  s1.tick`, `alpha = (renderTick - s0.tick) / (s1.tick - s0.tick)`, lerp de
  posição e de yaw (yaw pelo caminho curto — cuidado com o wrap de ±180°).
- Buffer seco (renderTick alcançou o snapshot mais novo): congela no último
  estado conhecido. Extrapolação é backlog.

---

# Glossário Unreal → nosso

| Unreal                          | Aqui                                      |
|---------------------------------|-------------------------------------------|
| GameMode / GameState (server)   | classes de simulação no Spring            |
| PlayerController + RPC de input | WebSocketSession + mensagem `input`       |
| Pawn possuído                   | entidade player com `owner` = playerId    |
| Seamless travel / join-in-progress | fluxo de join + full sync da instância |
| Replicação de actors            | mensagens `spawn` / `despawn`             |
| Simulated proxy (interpola)     | TODA entidade no client, na fase 1        |
| Autonomous proxy (prediz)       | fase 2                                    |
| NetUpdateFrequency              | taxa de snapshot (20/s)                   |

---

# Instâncias e o fluxo de join

Uma **Instância** = uma partida: uma dungeon + até 4 players + monstros/loot
+ um game loop próprio. Nasce quando o primeiro player entra, morre quando o
último sai. Players entram e saem a qualquer momento (join-in-progress).

## Três camadas, três momentos

1. **Conexão** — login HTTP + handshake WS autenticado. Conectado ≠ jogando:
   a sessão existe, mas não pertence a instância nenhuma.
2. **Membership** — o `join` associa a sessão a UMA instância (invariante:
   no máximo uma por player).
3. **Presença** — a game thread da instância processa a entrada e a entidade
   do player passa a existir no mundo.

## Find-or-create atômico

`join` = UMA operação: "ache a primeira instância RUNNING com vaga; não
havendo, crie". O caso inicial "zero instâncias no server" NÃO é caso
especial — lista vazia cai no braço do create sozinha.

Dono da operação: `InstanceManager`, o ÚNICO objeto que cria/destrói
instâncias e mexe em membership. `join`/`leave` são `synchronized` no
manager — join acontece em frequência humana, o lock não contende. A game
thread da instância NUNCA pega esse lock: mudanças de membership chegam
nela como eventos (`PlayerJoined`/`PlayerLeft`) na fila de entrada da
instância — o single-writer sobrevive intacto.

Corridas que o lock mata (todas são check-then-act):
- dois joins simultâneos com zero instâncias → criaria DUAS instâncias;
- dois joins numa instância 3/4 → viraria 5/4;
- join selecionando uma instância no exato instante em que o último player
  sai dela.

**Dois contadores, de propósito:** o manager conta *reservas de vaga* (sob o
lock — é o que o check de "cheia?" usa); a lista de entidades do mundo é
outra coisa, atualizada pela game thread quando processa o `PlayerJoined`.
Sem a reserva, 4 joins rápidos passariam todos antes do primeiro tick
processar qualquer um.

## Ciclo de vida

`RUNNING → CLOSING → DEAD`. Join só seleciona RUNNING. Quando um leave zera
a reserva, o manager (ainda sob o lock) marca CLOSING e cancela o
`ScheduledFuture` do tick. Join concorrente: ou pegou o lock ANTES (entra,
reserva=1, ninguém fecha nada) ou DEPOIS (não enxerga a CLOSING e cria
outra). Qualquer intercalação é consistente.

## O que o novato recebe — as três temperaturas do estado

Join-in-progress obriga um full sync, e o estado tem três classes:

- **Estático** — o layout da dungeon. Mandado UMA vez, no join, **como
  DADO** (grid de tiles), nunca como seed. Mesma lógica do "sem física
  compartilhada": gerador determinístico idêntico em Java e TS é armadilha
  de determinismo cross-language que não precisamos comprar.
- **Semi-estático** — portas abertas, chaves pegas, loot no chão, boss vivo.
  Muda raro e por EVENTO: vai completo no sync do join, depois só como
  mensagens de evento (`doorOpened`, ...). NÃO entra no snapshot de 20 Hz.
- **Dinâmico** — posição/estado de players e monstros: o snapshot de 20 Hz,
  como sempre.

## Sequência

```
client (/ws/signaling)                server
  |--- {"operation":"join"} ---------->|  IO thread → manager.join(player)
  |                                    |  manager (lock): acha/cria instância
  |<-- {"operation":"join",            |  RUNNING com vaga, reserva a vaga
  |     "result":"ok","instanceId":3} -|

client (socket de jogo)
  |--- conecta ws://.../game --------->|  manager correlaciona pelo Principal
  |                                    |  (já sabe Alice → instância 3) e
  |                                    |  enfileira PlayerJoined na instância
  |                                    |  ...tick N da instância drena a fila:
  |<-- welcome (id, instanceId, tick) -|
  |<-- mapSync (grid estático) --------|
  |<-- stateSync (portas/loot + tudo   |
  |               que está vivo) ------|
  |<-- snap tick N, N+1, ... ----------|  fluxo normal daqui em diante
  |                                    |
  |  (para os OUTROS, nos sockets de   |
  |   jogo deles)                      |
  |<-- spawn do novato ----------------|
```

O join no signaling só RESERVA; a chegada é a conexão do socket de jogo. Quem
manda welcome/mapSync/stateSync é a GAME THREAD, no tick que processa o
`PlayerJoined` — não a thread de IO. Dois ganhos: todo send do jogo sai de
uma thread só, e os syncs são um corte consistente do mundo no tick N (nada
de estado rasgado no meio de uma simulação). Custo: o ack demora até 50 ms.
Irrelevante. Conectar o socket de jogo SEM reserva prévia = fecha na cara
(mesma classe do 403: sessão sem instância não tem o que fazer ali).

## Leave — três portas, um caminho

`{"operation":"leave"}` explícito no signaling, `afterConnectionClosed` (de
QUALQUER um dos dois sockets — fechou a aba, caiu a conexão) e timeout
(backlog) — TODOS caem em `manager.leave()`: enfileira `PlayerLeft` na
instância, decrementa a reserva sob o lock, zerou → CLOSING.

**Morte ≠ leave.** Player morto continua membro (respawn/espectador é
decisão de gameplay, depois); a vaga continua dele.

Duplo login (mesma conta, segunda aba): fase 1 REJEITA o segundo join com
`{"operation":"join","result":"alreadyInGame"}`. Derrubar a sessão antiga é
backlog.

## Threads com N instâncias

Um `ScheduledThreadPoolExecutor` COMPARTILHADO (pool pequeno, bean do
Spring); cada instância agenda o próprio `scheduleAtFixedRate`. Garantia que
segura o modelo: o executor NUNCA roda a mesma task periódica em paralelo
consigo mesma (tick estourou 50 ms → o próximo espera, não sobrepõe) e há
happens-before entre execuções consecutivas — "um escritor lógico por
instância" sobrevive mesmo com a thread física variando entre ticks. O lock
do manager guarda SÓ lista de instâncias + membership; estado de mundo,
jamais.

---

# Protocolo (JSON na fase 1)

JSON via Jackson primeiro — debugável no DevTools. Protocolo binário é
milestone futuro, COM medição de bytes/s antes e depois (no espírito dos A/B
da engine). Toda mensagem tem um campo **`operation`** discriminador
(renomeado de `t` em 2026-07-13 — legibilidade > bytes enquanto for texto).

DOIS canais WS, cada um com a ordem TCP própria (NÃO existe ordem ENTRE eles):

- **`/ws/signaling`** — baixa frequência: join/leave de instância (e futuro
  social/lobby). O join AQUI só reserva a vaga no manager e responde com o
  `instanceId`.
- **socket de jogo** (rota a definir, ex. `/ws/game`) — a chegada de verdade:
  conectou, o manager correlaciona pelo Principal (já sabe Alice → instância
  3) e a game thread manda welcome/syncs/snaps por ELE. A garantia de ordem
  do sync vive inteira num stream só.

No server cada direção é uma família: `sealed interface` + records
(`ClientMessage` = o que o server LÊ, `ServerMessage` = o que ESCREVE), com
`@JsonTypeInfo(property="operation")` + `@JsonSubTypes`. O `operation` é
METADADO do Jackson, não campo das classes — o tipo da classe É a operação.
(Boot 4 = Jackson 3: databind em `tools.jackson.*`, anotações continuam em
`com.fasterxml.jackson.annotation`, exceptions viraram unchecked.)

Client → Server:

```
{"operation":"join"}                             // signaling; sem nome, sem instância:
                                                 // identidade vem da AUTH, first-fit
{"operation":"leave"}                            // signaling
{"operation":"input", "seq":123, ...}            // socket de jogo, a 20 Hz; campos
                                                 // exatos quando o gameplay 1a fechar
{"operation":"ping", "cs":<performance.now()>}   // socket de jogo
```

Server → Client:

```
{"operation":"join", "result":"ok", "instanceId":3}   // signaling: vaga reservada
{"operation":"join", "result":"alreadyInGame"}        // signaling: recusa (result
                                                      // por operação, sem msg "error")
{"operation":"welcome",   "id":7, "instanceId":3, "tickRate":20, "tick":4000}
{"operation":"mapSync",   "w":32, "h":32, "rows":["########","#..K...#", ...]}
{"operation":"stateSync", ...}                   // semi-estático + spawn em massa
                                                 // de tudo que está vivo
{"operation":"spawn",     "ents":[{"id":9,"kind":"player","owner":9,"x":0,"z":0,"yaw":0}]}
{"operation":"despawn",   "ids":[9]}
{"operation":"snap",      "tick":4021, "ents":[{"id":9,"x":1.2,"z":3.4,"yaw":0.5}, ...]}
{"operation":"event",     ...}                   // semi-estático: doorOpened,
                                                 // keyPickedUp, ... (entra na 1c)
{"operation":"pong",      "cs":<eco do ping>}    // RTT = now - cs
```

`mapSync` com uma STRING por linha de tiles, estilo mapa de roguelike — dá
pra LER a dungeon no DevTools, que é o motivo inteiro de ficar em texto.

Garantia de ordem: o TCP preserva ordem POR SOCKET, e no socket de jogo o
server SEMPRE manda `welcome → mapSync → stateSync` antes do primeiro `snap`
da sessão, e `spawn` antes do primeiro `snap` que contém a entidade.
(Aproveita — em transporte não-confiável, fase distante, essa garantia
morre.) Client que receber id desconhecido num snap loga warn e ignora.

Identidades: o nome do Principal ("Alice") é identidade de CONTA; `id` é
identidade de ENTIDADE, atribuído pela instância. O client nunca declara id
nenhum — a sessão já diz quem ele é e em que instância está.

RTT: mandar `ping` a cada ~1 s, mostrar na UI.

---

# Autenticação (Spring Security, desde a fase 1)

Identidade é o Princípio 1 aplicado: o client NÃO declara quem é — o server
sabe. Por isso o `join` não carrega nome.

- Restrição que dita o design: `new WebSocket()` no browser não aceita
  headers. Logo: **login por HTTP → cookie de sessão → o handshake do WS (que
  é um GET com Upgrade) passa pela filter chain e a `WebSocketSession` nasce
  com o `Principal`** (`session.getPrincipal().getName()` = playerId humano).
- `SecurityFilterChain` em bean (o `WebSecurityConfigurerAdapter` de
  antigamente MORREU no Security 6): `/ws/**` exige role `PLAYER`,
  `anyRequest().authenticated()`, `formLogin` default (`POST /login`
  form-encoded), logout default.
- Users em `InMemoryUserDetailsManager` com senha `{noop}` — só dev. User
  store de verdade (BD + bcrypt) é backlog. Existe um user `espectador` SEM a
  role PLAYER só pra testar o 403 (autenticado ≠ autorizado).
- CSRF desligado na fase 1: o único POST é o /login e WS não é coberto por
  CSRF. Religar quando houver REST mutável.
- Dev: proxy do Vite (`/ws` com `ws:true`, `/login`, `/logout` → :8080) deixa
  tudo same-origin — sem briga de SameSite de cookie — e o
  `setAllowedOrigins` do WsConfig fica explícito em `http://localhost:5173`.
- Erros com cara de "do nada": handshake com 302 = não logado; 403 = sem
  role; WS morrendo após restart do devtools = sessão em memória evaporou,
  re-loga.
- Backlog multi-server: padrão TICKET (login devolve token de uso único que
  vai na query do ws://) — entra quando existir signaling/matchmaker.

---

# Server (Spring Boot)

- `spring-boot-starter-websocket`, handler CRU: `TextWebSocketHandler`
  registrado num `WebSocketConfigurer` em `/ws`, `setAllowedOrigins("*")` em
  dev. **NÃO usar STOMP/SockJS** — broker pub/sub é modelo de chat, não de
  game server.
- **Single-writer, a regra de ouro:** as threads de IO do container (Tomcat)
  só fazem parse (Jackson) e ROTEIAM: `join`/`leave`/`afterConnectionClosed`
  vão pro `InstanceManager`; o resto (`input`...) vai pra
  `ConcurrentLinkedQueue<InboundMsg>` da instância da sessão (lookup num
  `ConcurrentHashMap<sessão, Instance>` que o manager mantém — ele põe a
  sessão no map ANTES de enfileirar o `PlayerJoined`, então input que chega
  em seguida cai na fila certa, DEPOIS do join, na ordem certa). Ninguém
  além da game thread da instância toca no estado do mundo dela.
- **Game loop:** um `ScheduledThreadPoolExecutor` compartilhado; cada
  instância agenda seu `scheduleAtFixedRate(this::tick, 0, 50, MILLISECONDS)`
  (ver seção Instâncias). Cada tick:
  1. drena a fila (PlayerJoined/PlayerLeft/input) e aplica no estado;
  2. simula dt = 50 ms fixo;
  3. serializa o snapshot UMA vez e manda a mesma string pra toda sessão da
     instância.
  Como só a game thread da instância chama `sendMessage` das sessões dela,
  não há concorrência no send.
- Client lento/travado pode bloquear o send e atrasar o tick — quando doer,
  embrulhar as sessões em `ConcurrentWebSocketSessionDecorator` (limite de
  tempo e de buffer). Anotado, não é fase 1.
- Validação mínima de input: clamp de `thrust` em [0,1] e `turn` em [-1,1].
  Anti-cheat de verdade é backlog.

## Movimento da fase 1 (dungeon)

Continua no plano XZ: personagem anda em 8 direções com velocidade constante
(Gauntlet não tem inércia), `yaw` = direção que está encarando (derivado do
movimento, não de input próprio). Colisão player×parede = AABB contra o grid
de tiles, resolvida no server. Monstros, combate e constantes entram quando
o gameplay 1b chegar. (A física de nave com thrust/drag da ideia original da
arena morreu com o pivot pro Gauntlet.)

---

# Client (mapeamento pro engine)

- Mundo `GauntletWorld` em `src/gauntlet/` (já existe — estágio 0: cubo,
  login e echo). Personagem = placeholder (o cubo serve) até existir asset;
  dungeon client-side = instanciar tiles a partir do `mapSync`.
- `NetClient`: dono do WebSocket. **Mesmo padrão single-writer do server,
  espelhado:** o `onmessage` só parseia e enfileira; quem drena e aplica é o
  `update()` do mundo, no início do frame. Simetria bonita: em nenhum dos
  lados um callback de IO toca o mundo.
- Registry `Map<netId, Node>` no mundo: `spawn` → `prefab.instantiate` +
  registra; `despawn` → `scheduleDestroy` + remove.
- Interpolação: buffer de snapshots (guardar ~1 s) + o esquema de
  `renderTick` da seção Relógio. Pode ser uma behaviour por entidade lendo um
  buffer central, ou um interpolador único que varre o registry — decisão de
  implementação, tanto faz pro modelo.
- Input: behaviour que mantém o estado do teclado (keydown/keyup) e manda
  `input` a 20 Hz com `seq++` — manda mesmo sem mudança (o server usa o último
  recebido como intenção corrente; input parado = continua valendo).
- UI (Redux, como sempre): painel de conexão (URL, connect/disconnect),
  status, RTT, lista de players.

---

# Explicitamente FORA da fase 1

Prediction/reconciliation, lag compensation, protocolo binário, delta
snapshots, interest management, lobby/social (entrar na instância de amigo),
reconnect com grace period, persistência, anti-cheat além do clamp.

# Roadmap

- **1a — andar na dungeon**: mapa HARDCODED pequeno (o protocolo não sabe a
  diferença — `mapSync` manda dado do mesmo jeito), InstanceManager +
  join/leave, input de movimento, colisão com parede no server, snapshot +
  interpolação. É o marco "multiplayer de verdade funcionando".
- **1b — monstros e combate**: spawn/AI simples no server, ataque, HP,
  morte/respawn. Testa spawn/despawn dinâmico em volume.
- **1c — chaves, portas e loot**: inaugura o canal de EVENTOS semi-estáticos.
- **1d — procgen + boss**: geração procedural da dungeon (server-side, vira
  dado no `mapSync` como sempre) e o boss da saída.
- **2 — prediction**: personagem próprio prediz localmente e reconcilia via
  `seq`.
- **3 — backlog**: binário (medir!), delta, lag comp, lobby/social.

# Layout

Server em `gauntlet_server/gauntlet/` (Maven, Boot 4.1, Java 17,
`net.dongeronimo.gauntlet`). Client é o mundo em `src/gauntlet/`.
