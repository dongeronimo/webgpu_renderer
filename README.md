# WebGPU Volume Renderer v2

Renderizador de volume médico em WebGPU. Enquanto o volume renderer em si não chega, o repositório contém a mini-engine que o sustentará — grafo de cena, materiais, render passes, scripting e UI — estressada por mundos de teste. Este repositório inclui também o `dicom_converter.py`, o script de pré-processamento que converte séries DICOM no formato consumido pelo renderizador.

```bash
npm install
npm run dev     # dev server do Vite
npm run build   # tsc + build de produção
```

# Arquitetura

## Visão geral

```
main.ts                    infra da aplicação: initWebGPU, canvas, RAF loop, registro de behaviours
  └─ World (abstrato)      dono do conteúdo E da cadeia de render passes
       ├─ createRenderPasses(canvas, format)   → como se desenha (os passes)
       ├─ createWorld(perspective)             → o que se desenha (assets, materiais, câmera)
       ├─ update(dt)                           → behaviours + cache de worldMatrix, uma travessia
       ├─ render(encoder)                      → grava os passes na ordem que ESTE mundo quer
       └─ destroy()                            → libera GPU e solta o canvas
```

O loop do main é só `world.update(dt)` → `encoder` → `world.render(encoder)` → `submit`. O main não conhece nenhum pass; cada mundo monta sua própria cadeia (o sistema solar usa skybox → mesh → final; um mundo futuro pode ter shadow/gbuffer/volume). Trocar de "fase" é `destroy()` num mundo e repetir o ciclo de vida no próximo.

## Grafo de cena: Node + componentes

A cena é uma árvore de `Node`s (raiz "ROOT", do World). A regra de ouro do projeto: **composição, nunca herança** — não existe subclasse de Node. Funcionalidades são campos opcionais de componente:

- `node.renderable` — o que desenhar: referência da `Mesh` (quem tem os buffers de GPU), o `MeshType` (Static/Skinned, escolhe o vertex layout), o `material` e o `passMask` (bitmask de `RenderPassBit` dizendo em quais passes o nó aparece — é assim que o cubo do skybox vive na árvore sem aparecer no main pass).
- `node.camera` — só projeção (fovY em **graus**, aspect, near/far). A view sai do próprio Node: `view = invert(worldMatrix)`. Convenção -Z: a câmera olha pro -Z local (glTF/Blender), ao contrário do +Z da Unity.
- `node.behaviours` — scripts (abaixo).

Transformações: `position`/`eulerAngles`(graus)/`scale` locais, e `node.worldMatrix` como **cache O(1)** — refrescado top-down pela única travessia do `World.update`. A ordem dentro de cada nó importa: as behaviours rodam **antes** da matriz do nó fechar, então mudança no próprio nó vale no mesmo frame; mudança num ancestral só aparece no frame seguinte. `getWorldMatrix()` existe como variante O(profundidade) sempre-fresca pra leituras fora do frame (ex.: `lookAt`).

## Behaviours

Estilo Unity: classe com `update(deltaTime)` e referência ao `node`. Como JS não tem reflection depois da minificação, existe um **registry por nome** (`registerBehaviour(nome, classe)` no main) e o loader do glTF instancia pela custom property do Blender (ver seção do glTF). Behaviours também podem ser penduradas em código, no `createWorld`.

## Render passes

Cada pass é uma classe autocontida que grava seus comandos num encoder recebido. Os que existem:

- **SkyboxRenderPass** — roda primeiro e faz o clear do alvo; desenha um cubo (da árvore, `passMask = Skybox`) com a translação da view zerada no VS — cubemap se amostra por direção, então o tamanho do cubo é irrelevante. Sem depth attachment.
- **MeshRenderPass** — o main pass: coleta os renderables com o bit `Main`, ordena por pipeline→material, desenha num alvo offscreen próprio (cor + depth). `loadOp` do color é configurável (`"load"` quando o skybox já pintou).
- **FinalRenderPass** — compõe o offscreen no backbuffer com um triângulo fullscreen (`textureLoad` 1:1, sem sampler). É quem configura o `GPUCanvasContext`; o `destroy()` dele solta o canvas pro próximo mundo.

O uniform de frame (grupo 0) carrega **view e proj separadas** (128 bytes) — os shaders compõem `proj * view * model`. Separadas de propósito: sombra e iluminação vão precisar delas individualmente.

## Materiais (a parte enrolada — leia esta seção)

O nó do problema: em WebGPU, **não dá pra separar material de `GPURenderPipeline`** — o pipeline é exatamente "o shader + estado de render de um tipo de material". A confusão clássica é misturar o que é do *tipo* com o que é de cada *objeto*. A divisão que o sistema usa:

| | quem é | vira o quê na GPU | onde vive |
|---|---|---|---|
| **TIPO de material** | a subclasse (`UnshadedOpaque`, `UnshadedTextured`...) | `GPURenderPipeline` (shader WGSL, cull, depth, blend) | cache **static** da subclasse, um pipeline por `MeshType` — todas as instâncias compartilham |
| **INSTÂNCIA de material** | o objeto (`new UnshadedOpaque(device, [1,0,0,1])`) | uniform buffer / texturas + `GPUBindGroup` | membros da instância |

Ou seja: "vermelho" e "azul" são duas instâncias de `UnshadedOpaque` — dois bind groups, **um** pipeline. O render pass ordena os draws por pipeline (troca mais cara) e depois por material, e só troca estado quando muda.

### Convenção de bind groups (a mesma pra todo shader de mesh)

```
grupo 0 = frame    (view + proj da câmera)          dono: o render pass
grupo 1 = objeto   (model matrices)                 dono: o render pass
grupo 2 = material (parâmetros, texturas, sampler)  dono: a instância de Material
```

Os layouts dos grupos 0 e 1 chegam à criação do pipeline pelo `PipelineContext` (montado pelo `MeshRenderPass`, que também informa os formatos de color/depth). O grupo 2 é o único que cada material define pra si.

### As model matrices (grupo 1)

Não existe um buffer por objeto. O `MeshRenderPass` tem **um** storage buffer (`var<storage, read> models: array<mat4x4f>`) com todas as matrizes do frame, na ordem de draw, e cada draw acha a sua via `drawIndexed(count, 1, 0, 0, i)` — o `firstInstance = i` chega no shader como `@builtin(instance_index)`. O invariante "ordem no buffer == ordem de draw" só é possível porque o **pass** faz as três etapas do frame (agrupamento → envio → draw); é por isso que o dono do buffer é o pass, não o material (e passes futuros de shadow/depth vão precisar das matrizes sem material nenhum). O buffer cresce dobrando quando o mundo passa da capacidade.

### Ciclo de vida e registry

- Materiais são criados no `createWorld` e registrados por nome: `registerMaterial("terra", new UnshadedTextured(device, tex))` — **antes** do `loadGltf`, porque o loader resolve a custom property `MaterialName` contra o registry na carga.
- Renderable sem material desenha com o **fallback magenta** — um "esqueci o material" gritando é melhor que um objeto invisível.
- Pipelines são criados **lazy** no primeiro frame que precisa deles (`getPipeline`), não na carga.
- `World.destroy()` destrói os materiais registrados (buffers/texturas das instâncias). Os caches static (pipelines, shader modules) ficam — valem pra vida da aplicação.

### Como criar um material novo

1. Subclasse de `Material` com o WGSL respeitando os grupos 0/1/2 e o vertex layout do `MeshType` (`StaticMesh.vertexLayout`: pos loc0, normal loc1, uv loc2; skinned soma joints loc3, weights loc4 — o shader pode ignorar locations que não usa).
2. Nível do tipo: `static pipelines = Map<MeshType, GPURenderPipeline>`, shader module e bind group layout do grupo 2 em static, criados on-demand.
3. Nível da instância: buffers/texturas próprios + o bind group do grupo 2; `getBindGroup()` o devolve; `destroy()` libera.
4. Registrar no `createWorld` antes do load. `UnshadedOpaque` é o gabarito mínimo; `UnshadedTextured` mostra textura + sampler (sampler é static — imutável, um pra classe toda).

## glTF e as custom properties do Blender

`loadGltf(device, url)` (gltf-transform, todas as extensões registradas) devolve `{ roots, nodes, meshes }`: a árvore com transforms **locais** (matrizes são decompostas em TRS), os renderables já ligados às meshes (buffers de GPU criados na carga; primitivas compartilhadas viram uma Mesh só; mesh multi-primitiva vira nós filhos extras), e a lista de meshes — o mundo guarda essa lista porque é ele quem as destrói.

A montagem da cena é dirigida por **custom properties** criadas no Blender (painel Object > Custom Properties). O loader lê as chaves de forma **case-insensitive**:

| chave | valor | efeito |
|---|---|---|
| `Behaviour` ou `Behaviours` | lista separada por `;`, ex.: `terraRotation;sunColour` | instancia cada behaviour pelo registry e pendura no nó (nome desconhecido = erro na carga) |
| `MaterialName` | uma string, ex.: `terra` | resolve no registry de materiais e atribui ao renderable (não registrado = warn + magenta) |

**Checklist de export do Blender (glTF 2.0):** marcar `Include > Data > Custom Properties` (senão as properties não saem) e `Include > Data > Cameras` se a câmera do mundo vier do Blender. Todas as extras ficam disponíveis em `node.extras` pra usos futuros.

## Texturas

- `loadTexture(device, url)` — imagem 2D via fetch → `createImageBitmap` → `copyExternalImageToTexture`, formato `rgba8unorm-srgb` (a GPU lineariza na amostragem). Sem mipmaps ainda.
- `loadCubemapTexture(device, url)` — espera **uma** imagem em cruz horizontal 4×3 e recorta as 6 faces pra uma textura de 6 layers (view `dimension: "cube"`, amostrada por vetor de direção):

```
      [+Y]
[-X]  [+Z]  [+X]  [-Z]
      [-Y]
```

Ambos validam o content-type da resposta — o dev server do Vite responde caminho inexistente com o index.html e status 200, o que sem o guard viraria um erro de decode indecifrável.

## UI (React + Redux)

A UI é DOM: uma `#ui-root` transparente por cima do canvas (congruentes por CSS num container `position:relative`), com `pointer-events:none` na raiz e `auto` só nos widgets — clique no "vazio" atravessa até o canvas. React monta aí (`src/ui/`), recebendo a instância de World por prop.

A fronteira renderer↔UI tem **dois canais unidirecionais**:

- **UI → engine (intenção, baixa frequência): Redux** (`src/redux/`, estilo clássico — actions e reducers à mão). O store é um singleton importado pelos dois lados; behaviours leem `store.getState()` dentro do `update()` — como já rodam todo frame, isso é reativo por construção, sem subscription pra vazar.
- **engine → UI (estado por-frame): pull no scene graph.** O hook `usePolled(read, hz)` lê a árvore N vezes por segundo (ex.: `world.findNode("Terra").worldMatrix`); a engine nem sabe que está sendo observada. `read` devolve snapshot, nunca referência viva (as matrizes são mutadas in place).

Regra de bolso: **Redux = o que o usuário quer; scene graph = o que está acontecendo.** Dado por-frame nunca passa por dispatch.

## Limitações conhecidas / próximos passos

- Skinning: o vertex format skinned existe, mas não há esqueleto/IBMs/animação — desenha rígido.
- Sem mipmaps (precisa de um pass de geração); sem depth prepass; sem sombras/luzes (view/proj já separadas pra isso).
- Loader ignora câmeras/luzes do glTF (câmera é montada no `createWorld`).
- O alvo offscreen é do `MeshRenderPass` embora o skybox desenhe nele; quando a cadeia crescer, os alvos passam pro mundo.
- Troca de mundo em runtime tem a infra (`destroy()`) mas nunca foi exercitada.

# Utilidades
---
## dicom_converter.py

Script CLI que converte uma série DICOM (fatias de tomografia/exame) em buffers binários float16 prontos para serem consumidos pelo renderizador de volume WebGPU. O fluxo principal:

1. **Leitura e ordenação** — Varre recursivamente o diretório de entrada, carrega tudo que for DICOM válido com pixel data, e ordena as fatias por `InstanceNumber`, com fallback para `SliceLocation` e depois pela coordenada Z de `ImagePositionPatient`.

2. **Montagem do volume em HU** — Carrega todas as fatias num array 3D float32, aplicando `RescaleSlope`/`RescaleIntercept` para converter os valores brutos em Hounsfield Units. Os valores ficam em HU mesmo, sem normalização, e o min/max global é registrado.

3. **Suavização opcional na GPU** — Se o CuPy estiver instalado, aplica difusão anisotrópica de Perona-Malik 3D: um filtro que suaviza ruído mas preserva bordas, usando vizinhança de 6 conexões, coeficiente de difusão racional (`1/(1+(∇/K)²)`, K=50 HU) e 5 iterações por padrão. Sem CuPy, o volume segue sem suavização.

4. **Histograma por chunk** — Divide o volume em chunks cúbicos (32³ por padrão) e calcula um histograma de valores HU para cada chunk (32 bins por padrão). Ver detalhes abaixo.

5. **Saída** — Grava no diretório de destino:
   - `slice_0000.raw` ... `slice_NNNN.raw` — cada fatia como float16 cru (2 bytes/voxel);
   - `chunk_histograms.bin` — os histogramas de cada chunk como contagens uint32;
   - `metadata.json` — dimensões, formato, espaçamento de pixels, espessura de fatia, window/level, faixa de HU, configuração dos chunks/histogramas e dados de paciente/estudo/série.

6. **Anonimização** — Habilitada por padrão: nome do paciente, ID e UIDs de estudo/série são substituídos por hashes SHA-256 truncados com salt fixo. Usar `--no-anonymize` exige confirmação interativa.

   ⚠ Campos como data de nascimento, sexo e datas do estudo **não** são anonimizados — só nome, ID e UIDs. Se a intenção for des-identificação completa (padrão HIPAA/LGPD), esses campos ainda vazam informação.

## Empty space skipping com histogramas por chunk

Em vez de gravar só o min/max de cada chunk, o conversor grava um **histograma de valores HU por chunk**. A motivação: com uma transfer function **não monótona** (ex.: opaca em osso e em vaso contrastado, mas transparente na faixa de tecido mole entre eles), o intervalo `[min, max]` de um chunk pode cruzar regiões opacas da transfer function sem que o chunk contenha *nenhum* voxel opaco — o teste min/max geraria um falso positivo e o chunk não seria pulado. Com o histograma, o renderizador sabe exatamente **quais faixas de valor existem** dentro do chunk:

> Um chunk pode ser pulado se, e somente se, todos os bins ocupados (contagem > 0) mapeiam para opacidade zero na transfer function atual.

Isso permite recalcular a máscara de chunks "vazios" na GPU sempre que a transfer function muda, sem reprocessar o volume.

### Detalhes de implementação

- **Binning**: os bins são uniformes no intervalo `[histogramMin, histogramMax]` (registrado no `metadata.json`), calculado sobre o volume **pós-suavização**, de modo que nenhum voxel cai fora do intervalo. Largura do bin = `(histogramMax - histogramMin) / histogramBins`.
- **Chunks de borda**: chunks parciais nas bordas do volume **não** são preenchidos com zero-padding — só voxels reais são contados. Em HU, zero é um valor significativo (água), então padding contaminaria os histogramas.
- **Layout do `chunk_histograms.bin`**: array denso `uint32`, little-endian, com shape `(numChunksZ, numChunksY, numChunksX, histogramBins)` em ordem C (row-major). O offset do bin `b` do chunk `(x, y, z)` é:
  ```
  offset = (((z * numChunksY + y) * numChunksX + x) * histogramBins + b) * 4 bytes
  ```
- **Campos no `metadata.json`**: `chunkSize`, `numChunksX/Y/Z`, `totalChunks`, `histogramBins`, `histogramMin`, `histogramMax`, `histogramDtype`.

## Uso

```bash
# Conversão padrão (suavização + anonimização, chunks 32³, 32 bins)
python dicom_converter.py -i ./dicom_data -o ./output

# Sem suavização
python dicom_converter.py -i ./dicom_data -o ./output --no-smooth

# Mais iterações de suavização
python dicom_converter.py -i ./dicom_data -o ./output --iterations 10

# Chunks maiores e histogramas mais finos
python dicom_converter.py -i ./dicom_data -o ./output --chunk-size 64 --histogram-bins 64

# Manter identificadores originais do paciente (pede confirmação)
python dicom_converter.py -i ./dicom_data -o ./output --no-anonymize
```

### Opções

| Opção | Padrão | Descrição |
|---|---|---|
| `-i, --input` | (obrigatório) | Diretório com os arquivos DICOM |
| `-o, --output` | (obrigatório) | Diretório de saída |
| `--no-smooth` | off | Pula a suavização Perona-Malik |
| `--iterations N` | 5 | Iterações de suavização |
| `--chunk-size N` | 32 | Lado do chunk cúbico (múltiplo de 16, entre 16 e 256) |
| `--histogram-bins N` | 32 | Bins do histograma por chunk (entre 2 e 1024) |
| `--no-anonymize` | off | Mantém identificadores originais do paciente |

### Dependências

```bash
pip install numpy pydicom
pip install cupy-cuda12x   # opcional, para suavização na GPU
```
