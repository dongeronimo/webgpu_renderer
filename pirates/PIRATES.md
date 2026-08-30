# Pirates! — notas de projeto

**Status: parado, à espera de retomada.** Documento escrito em 2026-08-29, no fim
da conversa de abertura do projeto, para que dê pra voltar nele sem refazer a
investigação. Nada foi implementado ainda — não existe `src/pirates/` nem
`tools/pirates/`.

Quarta vertical do portfólio: remake do **Sid Meier's Pirates! (2004)** sobre o
engine WebGPU deste repositório.

## Premissas

- Uso pessoal e de aprendizado. Sem distribuição comercial; no máximo jogar com
  amigos. Se algum dia virar algo vendável, os assets são refeitos do zero.
- Clean room por construção: WebGPU + engine próprio, zero código do original.
  O que se aproveita são os *assets*, convertidos.
- **Multiplayer desde o dia 1.** Enxertar rede depois dá errado.
- Os assets originais vivem em `D:\3d\pirates_assets` (Pak1..Pak8 + lang0).
  Não estão no repositório.

## Visão de longo prazo

Não é só um remake — é um remake que serve de base pra evoluir *além* do original,
no modelo do que o OpenTTD fez com o Transport Tycoon. Direções previstas:

- melhorar o sistema de esgrima;
- expandir o que se faz com as filhas dos governadores;
- **expandir o mapa** — 13 colônias, Brasil, e possivelmente o Atlântico inteiro
  (Angola, Nigéria, Mediterrâneo até Tunis, por causa da costa berbere).

Essa última tem consequência arquitetural imediata — ver "Precisão de coordenada".

Ciclo de trabalho pretendido: **1)** assets na tela (só os necessários) →
**2)** replicar os sistemas entre clientes → **3)** refinar → **4)** volta ao 1.

---

## Os assets originais

Tudo abaixo foi verificado lendo os bytes, não inferido de nome de arquivo.
Contagem total: 1080 `.nif`, 7481 `.kf`, 1011 `.kfm`, 2912 `.dds`, 262 `.bmp`,
161 `.tga`.

### Terreno — não precisa de parser de NIF

Esta é a boa notícia do projeto: **as ilhas se renderizam sem conversor nenhum.**

| Arquivo | O que é |
|---|---|
| `<ilha>_h.bmp` | **Heightmap**, BMP 8-bit paletizado. 52 ilhas. `abaco` = 128×160, `cuba` = 450×180 |
| `<ilha>_t.bmp` | Mesma resolução, **ID de textura por texel** (splat map) |
| `<ilha>_n.tga` | Normal map |
| `<ilha>_ch/_cc/_cs.bmp` | O mesmo conjunto em LOD grosso (`abaco` cai pra 39×48) |
| `<ilha>_s.dat` | Texto, `line = a,b,c,d` — 4 floats normalizados por linha |
| `<ilha>_trees.nif` | 9 blocos, 100% estático |
| `caribbeanmap.tga` | 1024×645, 24-bit — o mapa-múndi |

**O nível do mar é 127.** Está no `landscape.ini` (`WaterLevel = 127`) e — a
confirmação boa — a *paleta* do BMP troca de amarelo (índice 127) pra verde
(índice 128) exatamente nessa fronteira: era assim que o artista enxergava a
linha da praia enquanto pintava. Em `abaco_h.bmp` os valores vão de 103 a 152,
com o valor 104 ocupando 6169 texels (o fundo do mar).

A tabela de IDs do splat está em `landscapehills.ini`:
`1–5 = ocean1..5`, `16 = grasspatch`, `17 = grassbeach`, `48 = sand`, `49 = sandwet`.

O `_s.dat` é **hipótese não verificada**: provavelmente segmentos da linha de
arrebentação, casando com `SurfEnabled = 1` no `landscape.ini`. Dá pra confirmar
plotando os segmentos sobre o `_h.bmp` e vendo se caem na praia — mas só paga
quando a espuma entrar em cena.

**O que NÃO está nos assets: a posição de cada ilha no Caribe.** Isso vivia no
executável. Vai ser JSON escrito à mão sobre o `caribbeanmap.tga` — o que é
melhor assim, porque passa a ser dado nosso, e é justamente o arquivo do qual o
servidor vai ser dono.

O `landscape.ini` também tem `[TerrainPaging]` com `StreamCell_RADIUS = 25000`:
**o jogo de 2004 já paginava terreno** com 52 ilhas. Se o mapa virar o Atlântico,
"nunca carregar o mapa todo" deixa de ser otimização e vira premissa.

### Modelos — Gamebryo NIF

990 arquivos em **10.1.0.0**, 83 em 10.0.1.0 (header difere um pouco), 7
ilegíveis/versão antiga.

**Armadilha do formato:** o header traz a tabela de tipos de bloco mas **não traz
tamanho de bloco** — isso só chega no NIF 20.x. Parsing é sequencial, e um bloco
desconhecido no meio corrompe todo o resto do arquivo. A defesa certa é
**whitelist**: se o arquivo contém qualquer bloco fora da lista suportada, pula o
arquivo inteiro em vez de parsear até quebrar.

Superfície real pra malha estática — ~10 tipos, e só:

```
NiNode 990 · NiTexturingProperty 940 · NiSourceTexture 891 · NiMaterialProperty 893
NiTriStrips(+Data) 696 · NiTriShape(+Data) 390 · NiAlphaProperty 727
NiZBufferProperty 932 · NiVertexColorProperty 939
```

**`NiTriStrips` é maioria** (696 arquivos contra 390 de `NiTriShape`) — o conversor
tem que des-stripar pra triangle list. Todo o zoo de `NiPSys*` (partículas, 49
arquivos) fica de fora sem custo nenhum.

**Atalho pro primeiro navio na tela** — quais arquivos cabem quase no set estático:

| Arquivo | Blocos | Além do estático |
|---|---|---|
| `sloop1-lowend.nif` | 123 | só `NiCollisionData` |
| `ship_brigantine-lowend.nif` | 141 | só `NiCollisionData` |
| `fastgalleon-lowend.nif` | 165 | só `NiCollisionData` |
| `sloop1.nif` (completo) | 274 | `NiBillboardNode` + skinning |
| `<ilha>_trees.nif` | 9 | nada |

Os `-lowend` são navio inteiro precisando de **um** bloco a mais que o mínimo.
É por aí que se começa.

Nos navios completos, **as velas são skinnadas** (`NiSkinInstance/Data/Partition`) —
elas enfunam por bone, e é daí que vêm os `.kf` por navio
(`frigate_dummy_frigate_rudder_rudder.kf`). O sistema de skinning do engine já dá
conta, e aqui **não há retargeting**: é sempre o mesmo esqueleto, então a regra de
"só canal de rotação é seguro" não limita nada.

Ferramenta sugerida: **Python + PyFFI** (`pip install pyffi`; o `nif.xml` deles
cobre 10.1.0.0). Reader próprio só se o PyFFI engasgar — não vale escrever na mão
de cara, justamente por causa da ausência de tamanho de bloco.

Texturas: Pillow lê DXT1/3/5, então DDS→PNG na primeira passada. Passthrough de
BC direto pra GPU depois, se doer.

### Como re-verificar

O que sustenta as afirmações acima: ler o header do BMP (`offset 10` = início dos
dados, `18` = w/h, `28` = bpp; paleta em 54..1078) e o header do NIF (string
terminada em `\n`, depois `uint32` versão, `uint32` user version, `uint32`
num blocks, `uint16` num block types, e então `uint32 len + string` por tipo).

---

## Arquitetura

### Codebase único cliente/servidor, estilo UE/Unity

Rompendo com o que foi feito no Gauntlet (client TS + server Java segregados):
**mesmo código roda nos dois lados**, e o deploy de servidor simplesmente não
carrega assets gráficos nem executa código de render — exatamente o modelo do
*dedicated server build* do Unreal.

Três camadas, separadas por pureza:

| Camada | Conteúdo | `lib` do tsconfig |
|---|---|---|
| `sim/` | Node, Behaviour, entidades, navegação, regras de jogo | `["ES2022"]` — **sem DOM, sem @webgpu/types** |
| `client/` | render passes, materiais, input, UI, câmera | DOM + WebGPU |
| `server/` | entrypoint Node, transporte, autoridade, persistência | Node types |

**A separação é imposta pelo compilador, não por disciplina.** Com `sim/`
compilando sem DOM nem WebGPU, escrever `document` ou `GPUDevice` lá é erro de
compilação. É o fiscal.

O engine já está quase lá: `src/node.ts` e `src/behaviour.ts` são praticamente
puros — só `wgpu-matrix` (matemática, roda em Node) e imports `type-only` de
`Renderable`/`Camera`/`Skin`. Sobram **dois fios a cortar**:

1. `import { Light }` → virar `import type`;
2. `import { World }` → arrasta `world.ts`, que importa Redux e
   `showLoadingScreen`. Trocar por uma interface mínima num arquivo puro.

Isso é consequência direta da regra de composição-sobre-herança já adotada
("`renderable` é um campo opcional do Node"): é ela que faz o servidor rodar o
mesmo grafo com `renderable = null`.

### Decisões fechadas

| Decisão | Escolha | Por quê |
|---|---|---|
| Onde mora | `src/pirates/` no repo atual | Regra de "mundos = experimentos não-destrutivos" |
| Servidor roda o quê | **Scene graph completo** (Node/Behaviour em Node.js) | Modelo literal do UE; zero lógica duplicada |
| Runtime do servidor | **Node/TS**, não Java | Spring Boot não compartilha código com TS |
| Modelo de rede | Autoritativo + reconciliação (rewind/replay) | Já fechado e funcionando no Gauntlet |

**Não mover `src/node.ts` de lugar** — 10 mundos importam dele, e um big-bang de
imports não paga. `src/pirates/sim/` nasce com um `tsconfig.sim.json` próprio que
inclui `node.ts` transitivamente; o fiscal do compilador vigia os dois sem
ninguém mudar de pasta.

**Ganho de brinde:** isso resolve a dívida técnica nº1 do Gauntlet — as
constantes de movimento e a lógica de colisão escritas à mão duas vezes, em duas
linguagens (ver `GAUNTLET_MULTIPLAYER_NOTES.md`, seção "Valores que TÊM que
bater"). Aqui vira um `import`. O Gauntlet fica como está: baseline fechado, não
migra.

### Precisão de coordenada

Consequência direta de "o mapa pode virar o Atlântico", e a razão de estar aqui e
não numa fase futura: **é barato agora e caro depois.**

O Atlântico é ~10⁷ unidades com 1 unidade = 1 metro. Float32 tem mantissa de 24
bits: nessa distância o ULP já é **1 metro** — navio navegando devagar anda aos
pulos de um metro na borda do mapa.

Em JS a simulação não tem esse problema: `number` já é float64, de graça. O
problema está **dentro do engine, antes da GPU**:

```
src/node.ts:278   readonly worldMatrix: Mat4 = mat4.identity();   // Float32Array
```

Correção padrão de mundo grande: a sim guarda posição em float64, e a matriz de
mundo é montada **relativa à câmera** — subtrai a posição da câmera em float64 e
só então converte. Tudo que chega na GPU volta a ser número pequeno. O
`wgpu-matrix` já usado tem os namespaces `mat4d`/`vec3d` com `Float64Array` por
padrão (`dist/3.x`), então não entra dependência nova.

Fazer depois significaria mexer em todo render pass, no shadow map e no culling
de uma vez só.

### Determinismo — e por que NÃO virar lockstep

A comparação com o OpenTTD é certeira pro *modelo de evolução*, mas a netcode
deles é o oposto: OpenTTD é **lockstep determinístico** — todo mundo simula tudo,
só os inputs trafegam.

Nesse modelo, `Math.sin`/`Math.cos`/`Math.pow` matariam o projeto: a spec do
ECMAScript deixa a precisão dessas funções *implementation-defined*. Node e Chrome
são V8 e batem entre si; Firefox e Safari, não necessariamente. Num jogo de vela,
que é trigonometria pura, isso é divergência garantida.

No modelo autoritativo com reconciliação, o snap do servidor absorve a diferença.
**A escolha já feita é justamente a que permite rodar cross-browser.** Não migrar
pra lockstep por semelhança estética com o OpenTTD.

---

## Plano de execução

### Fase 0 — o alicerce

Cirurgia pequena em `src/node.ts`, feita de uma vez só porque é o mesmo arquivo:

- `import { Light }` → `import type`;
- `import { World }` → interface mínima em arquivo puro (quebra o ciclo com Redux);
- posição em float64 + matriz de mundo relativa à câmera;
- `tsconfig.sim.json` com `lib: ["ES2022"]`.

Aditivo e reversível. Nenhum mundo existente sente.

### Fase 1 — conversor de terreno

`tools/pirates/terrain.py`, sem dependências: `<ilha>_h.bmp` + `_t.bmp` +
`landscapehills.ini` → binário em `public/pirates/`. Manter os heights como
`Uint8` cru e fazer `(v - 127) * escala` na GPU — mais barato que expandir pra
float no disco.

**O formato de saída é neutro, não "o formato do Pirates".** O BMP paletizado do
jogo original é *um importer* pra ele. As 13 colônias, o Brasil e Angola não
existem nos assets — vão ser autorados, e é isso que torna a expansão possível.
Custo zero hoje.

### Fase 2 — o mundo

`src/pirates/piratesWorld.ts`: oceano + uma ilha de verdade, com material de
splat lendo `_t` como índice. É aqui que se define **a escala do mundo** — vale
ancorar nos números do `landscape.ini` (`StreamCell_RADIUS = 25000`,
`WakeMaximumWidth = 150`) em vez de inventar, já que tudo depois depende dela:
velocidade de navegação, distância entre ilhas, LOD, taxa de tick.

### Fase 3 — conversor de NIF

`tools/pirates/nif2gltf.py` com whitelist de blocos. Começa por
`sloop1-lowend.nif`. Des-stripar `NiTriStrips`. DDS→PNG via Pillow.

### Fase 4 — servidor e rede

Modelo de navegação (vento, rumo, ponto de vela) inteiro em `sim/`. Entrypoint
Node, WebSocket, tick autoritativo. Reaproveita o padrão de predição em passo
fixo + rewind/replay do Gauntlet, mas agora com as constantes vindo de um
`import`.

Posições das ilhas: JSON à mão sobre o `caribbeanmap.tga`.

**Primeiro marco:** carregar o mapa e os navios de Alice e Bob navegando por ele.

---

## Em aberto

- **A escala do mundo** (Fase 2). Tudo depois depende dela.
- **O que é o `_s.dat`.** Palpite de "linha de arrebentação" não verificado. Só
  paga quando a espuma entrar em cena.
- Os 83 NIFs em 10.0.1.0 e os 7 ilegíveis — gap pequeno, resolver se algum
  arquivo necessário cair neles.
- Esgrima, filhas de governador e economia são `sim/` puro e de baixa frequência:
  replicar é barato. O caro é a navegação — contínua, predita, todo frame. O
  primeiro marco já começa pela parte difícil, o que é a ordem certa.
