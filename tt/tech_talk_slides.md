# 1 - O que é Volume Rendering

## O que é volume rendering
- Processo de converter dados volumétricos (texturas 3D, texture arrays) em imagens, em tempo real
- "Tempo real" significa que o usuário interage com o resultado a velocidade decente (30fps+)
- Isso impõe restrições fortes de performance que não existem em renderização offline
- Diferente de malhas: o dado é um volume denso (ou esparso) de amostras, não uma superfície
- [Imagem: volume renderizado, ex. um CT scan]

## Pra que serve
- Imagem médica: tomografia (CT), ressonância (MRI) — ver estrutura interna sem cortar nada
- Visualização científica: simulações numéricas, nuvens de dados de sensores
- VFX e games: fumaça, nuvens, fogo, névoa — qualquer coisa "não-sólida" e volumétrica
- É a técnica por trás de qualquer efeito em que a câmera pode entrar no meio da coisa
- [Imagem: fumaça em jogo]

## Os dados
- Dado estruturado: texturas 3D / texture arrays — denso espacialmente, grid regular
- Dado esparso: pontos de realidade aumentada, fluidos, dados científicos espalhados
- A forma como o dado é armazenado importa: cada técnica é melhor pra um tipo
- Exemplo: raymarchers favorecem dado estruturado; splatting favorece dado esparso
- Hoje o foco é dado estruturado (textura 3D) — é o caso das duas técnicas que vamos ver

## GPUs não entendem volume
- GPU entende malhas: vertex shader, fragment shader, rasterização de triângulos
- Pra renderizar volume usamos uma malha como "gatilho" pro algoritmo volumétrico
- Um cubo (bounding box) é desenhado, e o fragment shader faz o trabalho de verdade
- É um workaround em cima de uma pipeline pensada pra superfícies, não pra volumes
- Esse é o pano de fundo de toda técnica que vem a seguir

# 2 - As restrições do problema

## Quality x Space x Speed
- Três eixos em tensão constante: Qualidade x Espaço x Velocidade
- Dá pra escolher dois dos três, não os três ao mesmo tempo
- Qualidade custa espaço moderadamente (tabelas de lookup, texturas auxiliares) e MUITA velocidade
- Velocidade se ganha fazendo menos — e "fazer menos" custa espaço (pré-calcular) ou custa qualidade
- [Imagem: o triângulo das escolhas]

## Exemplo de restrição: o gradiente
- Gradiente = taxa de variação do dado num ponto — dá informação de normal/superfície
- É um vec3 (dX, dY, dZ) ou vec4 (dX, dY, dZ, magnitude)
- Se o dado original é um f32 escalar, o gradiente já é ~4x o tamanho do dado
- Sem gradiente não dá pra iluminar a superfície implícita do volume
- Calcular em runtime (6-8 texture fetches + trilinear) x cachear numa textura própria (1 fetch, mais espaço)

# 3 - Técnica 1: Texture-based slicing

## Stack of slices — como funciona
- A textura 3D é "fatiada" por muitos planos, desenhados com blending ligado
- Quem integra o raio é a etapa de blending fixa da GPU, não um shader
- Técnica mais antiga da lista, ainda relevante porque é rápida
- Sombra e outras melhorias de imagem são bem mais difíceis aqui do que no raymarcher
- Gargalo: a etapa de blending e muitos fragmentos descartados

## Variações: axis-aligned x view-aligned
- Fatias podem ser axis-aligned (alinhadas aos eixos) ou view-aligned (alinhadas à câmera)
- Axis-aligned é mais simples, mas gera artefato visível ao trocar o eixo dominante
- View-aligned recalcula a malha da fatia todo frame, intersectando com a bounding box
- Custo de upload é pequeno nas GPUs de hoje, mas existe
- [Imagem: comparação axis-aligned x view-aligned]

## O que ela não ganha de graça
- Otimizações naturais de raymarching não se aplicam aqui
- Sem early ray termination (parar de amostrar quando já saturou opacidade)
- Sem empty-space skipping (pular regiões vazias do volume)
- O trabalho é proporcional ao número de fatias, não ao conteúdo do volume
- Em compensação: simples de implementar e custo bem previsível

# 4 - Técnica 2: Raymarching / Raycast

## Como funciona
- O raio é traçado explicitamente: marcha pelo volume, amostra e acumula cor/opacidade
- No passado era feito na CPU; hoje é a técnica padrão de volume rendering na GPU
- Custo cresce com o tamanho do dado e o número de raios (= fragmentos = pixels na tela)
- Totalmente paralelizável — cada raio é 100% independente dos outros
- Perfeito pra fragment shader ou compute shader

## Otimizações que ele ganha de graça
- Early ray termination: para de amostrar quando a opacidade acumulada já saturou
- Empty-space skipping: pula regiões vazias sem amostrar (ganho medido: ~31% mais rápido)
- Essas otimizações existem naturalmente porque o raio é explícito no shader
- Trade-off: shader mais complexo, mais controle de fluxo (branch) por fragmento
- [Imagem: raycast com e sem empty-space skipping]

# 5 - Comparando as duas técnicas

## As duas são a mesma ideia
- Texture-based slicing É um raymarcher — só que o raio é implícito
- Em vez de marchar no shader, desenhamos fatias e o blending fixo compõe o raio
- Tirando técnicas Fourier-based, todo volume rendering de dado compacto é raymarching de alguma forma
- A diferença real: quem faz a integração (fixed function x shader) e o controle que isso dá
- Esse controle é o que abre porta pra early termination, empty-space skipping, sombra etc.

## Artefato comum: onion rings
- Poucas fatias/amostras geram um padrão de "anéis de cebola" na imagem
- Causa: sub-amostragem de detalhes finos da transfer function entre duas amostras
- Mais amostras resolve, mas custa velocidade — de novo o triângulo qualidade x espaço x velocidade
- Cheat comum: ray jitter, troca o padrão regular por ruído (menos perceptível ao olho)
- [Imagem: texture_based_vr_sampling_artifacts.png]

## A correção de verdade: pré-integração (Engel, Kraus, Ertl 2001)
- Em vez de olhar 1 ponto por amostra, olha o PAR (amostra da frente, amostra de trás) de cada "fatia" do raio
- Pré-calcula uma tabela 2D T[frente][trás] = a transfer function já integrada nessa rampa
- Em runtime: 2 amostras de textura + 1 lookup na tabela 2D substitui o lookup pontual
- Resultado: poucas fatias parecem tantas quanto muitas — sem os anéis
- Custo: +1 texture fetch, e recalcular a tabela só quando a transfer function muda

# 6 - Caso aplicado: fumaça em jogo

## Fumaça como volume
- Mesma ideia de volume rendering, mas agora o volume é DINÂMICO — muda a cada frame
- Densidade (quanto de fumaça tem ali) e velocidade (pra onde ela vai) viram campos numa grade 3D
- Densidade é um campo escalar; velocidade é um campo vetorial — ambos texturas 3D
- Cada frame, um compute shader simula esses campos antes da textura ir pro renderer
- O renderer (raycast) é o MESMO já mostrado — só o conteúdo da textura 3D muda

## O pipeline da simulação, por alto
- Advecção: transporta densidade e velocidade pelo próprio campo de velocidade (a fumaça "anda" com o vento)
- Emissão: injeta densidade e velocidade nova numa região, com ruído pra não ficar uniforme
- Projeção de pressão: corrige a velocidade pra ela se comportar como um fluido incompressível
- Existem detalhes de instabilidade numérica e de como a pressão se resolve — hoje só precisamos saber que existem
- Obstáculos: uma máscara voxelizada faz a fumaça desviar de paredes e objetos sólidos

## O resultado
- O mesmo raymarcher usado pra dado estático (CT) renderiza a fumaça, sem trocar a técnica de imagem
- A diferença inteira está em COMO a textura 3D é preenchida, não em como ela é lida
- Esse é o ponto central: volume rendering é a camada de apresentação; a simulação é só mais um produtor de dado
- [Imagem/vídeo: fumaça em tempo real subindo e desviando de um obstáculo]

# 7 - Fechamento

## Recap
- Volume rendering: converter dado volumétrico em imagem, em tempo real, sob a restrição qualidade x espaço x velocidade
- Texture-based slicing: raio implícito, resolvido pelo blending fixo — simples e rápido, mas limitado
- Raymarching: raio explícito no shader — mais controle, mais otimização, mais complexidade
- No fim as duas são a mesma ideia (integrar um raio), pagando o custo em lugares diferentes
- Aplicação em jogo: a mesma técnica de imagem serve tanto pra dado estático (CT) quanto dinâmico (fumaça simulada)
