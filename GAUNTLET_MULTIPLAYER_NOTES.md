# Gauntlet multiplayer — notas de implementação

Terceira vertical do portfólio: clone do Gauntlet, server-autoritativo, Spring
Boot (WebSocket cru) + client TypeScript/WebGPU. Spec original em
`src/instructions/multiplayer.md`. Este arquivo documenta o que foi feito
nesta etapa (spawn/despawn/snap → skin renderizando → movimento
suave) pra quando for preciso voltar nisso.

**Não é um character controller de verdade.** É o suficiente pra andar,
virar e trombar em parede de um jeito que não parece quebrado. Character
controller de verdade — swept collision, reconciliação com replay de input,
constantes compartilhadas — fica pra quando der pra sentar com calma (ver
"Dívida técnica" no fim).

## Onde as coisas moram

**Server** — `gauntlet_server/gauntlet/src/main/java/net/dongeronimo/gauntlet/`

| Arquivo | Responsabilidade |
|---|---|
| `services/GameLoop.java` | O tick autoritativo (20Hz): drena input → `stepMovement` (aceleração+giro+colisão) → `broadcastSnap`. **Onde moram as constantes de movimento.** |
| `entities/Instance.java` | Estado de UMA partida: mundo (`Map<Long,WorldEntity>`), `intents` (última intenção por entidade), `velocities` (velocidade corrente suavizada por entidade), sessões. |
| `entities/WorldEntity.java` | Entidade PLANA (sem scene graph): id, kind, owner, x, z, yaw. |
| `entities/InstanceEvent.java` | Eventos que a IO enfileira e só a game thread drena: `PlayerArrived`, `PlayerLeft`, `PlayerInput`. |
| `entities/GameMap.java` | Grid + `isWalkable` + spawns. |
| `interfaces/ws/GameWS.java` | Parseia `ClientMessage` (JSON→sealed interface via Jackson), enfileira `PlayerInput`. |
| `interfaces/transferObjects/*` | DTOs do fio: `Welcome`, `MapSync`, `StateSync`, `Spawn`, `Despawn`, `Snap`/`SnapEntity`, `EntityDto`, `Input`, mais os sealed interfaces `ClientMessage`/`ServerMessage`. |

**Client** — `src/gauntlet/`

| Arquivo | Responsabilidade |
|---|---|
| `GauntletNetwork.ts` | O behaviour de rede: abre os WS, monta o mapa (Floor00/Wall00), spawna/despawna avatares (anexando `NetworkedEntityBehaviour` + `MineAvatarBehaviour` quando aplicável), repassa snap pra behaviour de cada entidade, conversão de coordenada e checagem de colisão (espelhando o server). |
| `NetworkedEntityBehaviour.ts` | Anexada em TODO pawn nascido de entidade do server (player hoje; monstro/tesouro amanhã) — blend de reconciliação por snap e dead reckoning entre snaps. `locallyPredicted` desliga o dead reckoning pro pawn local (quem move ele é a `MineAvatarBehaviour`). Futuro lugar do state→clip de animação. |
| `MineAvatarBehaviour.ts` | Só no pawn LOCAL, somada à `NetworkedEntityBehaviour`: lê teclado, prediz movimento+giro+colisão TODO frame (mesma regra do server), manda input a 20Hz. |
| `CameraFollowBehaviour.ts` | Anexada na câmera só quando o avatar local nasce; persegue com offset fixo todo frame. |
| `dto/ServerMessage.ts` | Espelho TS do `ServerMessage` sealed do Java — união discriminada por `operation`, pega erro de shape em compile time. |
| `gauntletWorld.ts` | Wiring do mundo: render passes (dungeon opaco + avatares skinnados, dois passes compostos no mesmo alvo), prefabs, câmera/luz. |

## ⚠️ Valores que TÊM que bater entre server e client

Não existe fonte única de verdade pra isso hoje — são constantes duplicadas
à mão nos dois lados. Se um mudar sem o outro, a predição local volta a
divergir da posição real (o mesmo tipo de bug do item "parede treme" abaixo
na seção de correções). Isso é a dívida técnica #1 — ver o fim do arquivo.

| Constante | Valor | Server (`GameLoop.java`) | Client (`MineAvatarBehaviour.ts` / `GauntletNetwork.ts`) |
|---|---|---|---|
| Velocidade de cruzeiro | `3.0` células/s | `MOVE_SPEED` | `MOVE_SPEED` |
| Aceleração | `20.0` células/s² | `ACCEL` | `ACCEL` |
| Taxa de giro | `540°/s` (`Math.toRadians(540)` no Java) | `TURN_RATE_RAD_PER_SEC` | `TURN_RATE_DEG_PER_SEC` |
| Raio do corpo (colisão) | `0.3` células | `PLAYER_RADIUS` | `PLAYER_RADIUS_CELLS` (em `GauntletNetwork.ts`) |
| Tick rate | `20 Hz` (50ms) | `TICK_RATE`/`TICK_MILLIS`/`DT_SECONDS` | implícito — client prediz a CADA FRAME (framerate variável), não a 20Hz; só o ENVIO de input é throttled a 20Hz |
| Tile size (mundo) | `2×2` unidades por célula | — (server só fala em células) | `new GauntletNetworkBehaviour(2, 2)` em `gauntletWorld.ts`, usado por `serverToWorldX/Z`/`worldToCellX/Z` |

Convenções que também têm que casar (não são número, mas são acoplamento
implícito servidor↔cliente):

- **Yaw**: server sempre radianos (`Math.atan2`, convenção "0 = encarando
  +Z"); client sempre graus (`node.eulerAngles`). A conversão
  (`RAD_TO_DEG = 180/Math.PI`) é module-local e duplicada em CADA arquivo
  client que precisa dela (`GauntletNetwork.ts`, `MineAvatarBehaviour.ts`) —
  de propósito, pra não criar um módulo compartilhado só pra uma constante,
  mas é outro lugar pra checar se o giro sair espelhado.
- **Colisão**: AABB de 4 cantos vs grid — `GameLoop.isFree` (server) e
  `GauntletNetwork.isFreeAtCells` (client) são a MESMA lógica escrita duas
  vezes, célula a célula, em linguagens diferentes. Qualquer mudança na
  regra de colisão do server (ex.: colisão circular, corner-rounding) tem
  que ser replicada aqui manualmente ou a predição volta a divergir.
- **Espaço de coordenadas**: server fala só em CÉLULAS (1 célula = 1
  unidade, origem no canto do mapa). Client converte pra unidades-mundo via
  `serverToWorldX/Z` (e o inverso, `worldToCellX/Z`) — é a ÚNICA
  transformação usada pra mapa E entidades; diverge aqui = pawn fora do
  lugar.

## O que foi corrigido nesta etapa (em ordem)

1. **Skin não renderizava.** Dois passes de render (`MainRenderPass` pro
   dungeon, `SkinnedRenderPass` pros avatares) cada um dono da PRÓPRIA
   textura de GPU — `FinalRenderPass` só lia a do `mainPass`, então tudo que
   o `skinnedPass` desenhava ia pro limbo. Corrigido dando ao
   `SkinnedRenderPass` um método `renderOnto(...)` que desenha DIRETO no
   color+depth do `mainPass` (mesmo padrão que `SkyboxRenderPass` já usava
   com `MainRenderPass` no StarshipDemo).
2. **Ainda não renderizava** depois do fix acima. O `depthStoreOp` do
   `mainPass` tava no default (`"discard"`) — o depth buffer sumia antes do
   `skinnedPass` poder testar contra ele, então o teste de profundidade
   falhava pra TODO fragmento do avatar. Corrigido passando `"store"`
   explícito na construção do `mainPass`.
3. **Câmera "fodida".** Uma `OrbitCameraBehaviour` (anexada concorrentemente
   por fora desta etapa) lia o slice GLOBAL do Redux de câmera, calibrado
   pro raycaster de volume em escala unitária (`radius: 2.3`) — no primeiro
   frame ela sequestrava a câmera fixa top-down do Gauntlet pra um raio
   minúsculo perto da origem. Removida.
4. **Bonecos deitados.** `node.eulerAngles = (0, yaw, 0)` no clone do
   armature SUBSTITUÍA (não compunha com) a rotação própria que o
   Blender/Mixamo já trazia no Armature (correção de eixo do import) —
   apagava a correção e derrubava o personagem. Corrigido com um nó PIVOT:
   yaw vai nele; o armature-clone (filho) mantém a rotação importada
   intacta, e a composição de matrizes do próprio `Node` cuida do resto.
5. **Bug latente de `isMine`.** Comparava `ent.owner` (id de CONTA) com
   `myId` (id de ENTIDADE, do `Welcome.id`) — "funcionava" só por
   coincidência quando entityId==playerId num teste com poucos players.
   Corrigido pra `ent.id === myId` (entidade com entidade).
6. **Parede tremendo.** A predição local não sabia NADA de colisão — ao
   segurar uma tecla contra a parede, a predição continuava andando pra
   dentro dela a cada frame enquanto o server segurava o pawn na borda; o
   blend de reconciliação (a 20Hz) puxava de volta a cada snap, criando um
   dente-de-serra visível = tremor rápido. Corrigido dando ao client a MESMA
   checagem AABB×grid do server (`isFreeAtCells`, espelhando `GameLoop.isFree`
   linha a linha), rodando ANTES de aplicar a predição.
7. **Virada instantânea entre opostos (ex.: `<-` pra `->`).** Yaw vinha de
   `atan2(velocidade)`. Ao inverter direção, a velocidade desacelera em
   LINHA RETA até zero (não em arco) — o ângulo fica PRESO na direção antiga
   o tempo todo em que só a magnitude cai, e só troca no instante exato em
   que a velocidade cruza zero → salto instantâneo. Corrigido desacoplando
   yaw de velocidade: agora é uma rotação própria, com taxa limitada
   (540°/s), rumo à direção do INPUT — começa a virar já, mesmo ainda
   freando da direção anterior, e varre os ângulos intermediários de
   verdade.

## Features adicionadas

- **Camera follow** (`CameraFollowBehaviour`): persegue o avatar local todo
  frame com offset fixo; substitui o snap único de quando o avatar nasce.
- **Movimento com aceleração** (`ACCEL`): a velocidade CORRENTE desliza até
  a intenção normalizada×`MOVE_SPEED` em vez de saltar direto — dá arcos nas
  transições entre as 8 direções do WASD e uma parada suave. Decisão
  consciente: continuam sendo só 8 direções ALCANÇÁVEIS (limitação do
  teclado), mas a TRANSIÇÃO entre elas deixou de ser instantânea.
- **Yaw com taxa de giro limitada** (`TURN_RATE`): ver item 7 acima.
- **Predição local**: o pawn do próprio player se move na hora, no client,
  pela MESMA regra de aceleração/giro/colisão do server — não espera o
  round-trip.
- **Dead reckoning dos remotos**: cada `Snap` carrega `vx`/`vz` (a
  velocidade corrente pós-suavização do server); entre snapshots (50ms), o
  client extrapola a posição dos OUTROS players por essa velocidade em vez
  de só "pular" a cada pacote.
- **Reconciliação por blend suave** (`SNAP_BLEND = 0.35`, só client): quando
  o snap chega, corrige uma FRAÇÃO do erro em vez de teleportar — tanto pro
  pawn local (cuja predição pode ter divergido um pouco) quanto pros remotos
  (cuja extrapolação também pode ter divergido). **Sem rewind/replay de
  input** — decisão consciente de escopo, ver dívida técnica.

## Dívida técnica / o que fica pro character controller de verdade

1. **Constantes duplicadas sem fonte única** (a tabela lá em cima). O jeito
   certo é o server mandar essas constantes uma vez (ex.: no `Welcome`, ou
   um endpoint de config) e o client SEMPRE ler de lá — hoje é copy-paste
   manual e qualquer desalinhamento reintroduz o bug #6.
2. **Reconciliação é só blend, sem histórico de input.** Sob perda de pacote
   ou desync grande, dá pra ver "rubber-banding" visível. O padrão de FPS
   competitivo (buffer de input com seq, rewind pra posição do server,
   replay dos inputs não confirmados) é mais robusto mas é bem mais código —
   ficou de fora por tempo.
3. **Sem colisão contínua (swept).** Cada tick testa a posição FINAL, não a
   trajetória — em teoria, num frame-hitch grande ou velocidade alta, dá pra
   atravessar uma parede fina num único passo. Improvável nas velocidades
   atuais (3 células/s, tick de 50ms = no máximo 0.15 células por tick), mas
   é uma bomba-relógio se `MOVE_SPEED` subir bastante.
4. **Dead reckoning dos remotos não checa colisão.** Só a predição do pawn
   LOCAL respeita parede (`isFreeAtCells`); um remoto pode aparecer
   brevemente "dentro" de uma parede durante a extrapolação até o próximo
   snap corrigir. Não incomoda muito a 20Hz, mas é inconsistente com o local.
5. **Só 2 prefabs fixos** ("alice"/"bob") — `onEntsAdded` escolhe visual só
   por `isMine`, não escala pra mais de 2 identidades visuais distintas.
6. **Sem animação de verdade** — os avatares desenham em bind pose. O sistema
   de `AnimatorBehaviour` já existe e funciona (provado no `SkinningDemoWorld`),
   só não foi conectado aqui. Plano: server manda `state` em `EntityDto`/
   `SnapEntity`, `NetworkedEntityBehaviour.applySnap` detecta transição e troca
   o clip do `AnimatorBehaviour` (achado como behaviour de um filho do pivot);
   falta ainda dar clip/`AnimatorBehaviour` de verdade aos prefabs `alice`/`bob`.
7. **Colisão é grid-cell AABB puro** — ótimo pra uma dungeon em grid, mas não
   generaliza pra geometria orgânica/não-alinhada a grid sem trocar a
   abordagem inteira (capsule vs. malha, por exemplo).

## Testes

Suíte Java existente (`gauntlet_server/gauntlet/src/test/`) — 13 testes,
todos verdes na última rodada (`GauntletApplicationTests`,
`ServerMessageSerializationTest`, `GameLoopTest`, `MapGeneratorTest`). Nenhum
teste novo foi escrito nesta etapa por decisão explícita (tempo curto) —
fica pra quando "der pra sentar e fazer o character controller de verdade".
