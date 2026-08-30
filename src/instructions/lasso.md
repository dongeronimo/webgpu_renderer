# Lasso de remoção (mundo `raycastLasso`)

O usuário desenha um polígono na tela e o que projeta dentro dele, **pela câmera
daquele instante**, para de ser renderizado. Vários lassos, com undo/redo.

## O modelo

Um lasso é **um polígono em NDC + a câmera congelada do desenho**, e não "uma
lista de segmentos + uma direção".

A diferença importa: com câmera perspectiva o sólido de remoção **não é um
prisma**, é uma **pirâmide infinita com ápice no olho**. Guardando a matriz
inteira (`proj * view * model` daquele instante) isso sai de graça — a amostra
some quando ela *projeta* dentro do polígono naquela câmera, que é exatamente a
semântica que o usuário viu quando desenhou. Um prisma (projeção ortográfica ao
longo do forward) casaria com o traço no centro da tela e desalinharia nas
bordas.

Como a matriz inclui a `model`, o corte fica **colado no volume**: girar a peça
leva o buraco junto.

Consequência boa de sanity check: **da mesma câmera do desenho, o raio inteiro
projeta num único ponto de NDC** — ou seja, logo depois de desenhar você vê o
recorte exato do traço. O túnel só aparece quando você orbita.

## Onde cada parte mora

| peça | arquivo | papel |
|---|---|---|
| tipos + Douglas-Peucker | `src/raycastLasso/lasso.ts` | o que é um lasso, e a simplificação do traço |
| pilha + undo/redo | `src/redux/{actions,reducers}.ts` (slice `lasso`) | lista completa + `cursor` |
| captura do traço | `src/ui/raycast_lasso/LassoOverlay.tsx` | px → NDC, simplifica, despacha |
| controles | `src/ui/raycast_lasso/LassoPanel.tsx` | modo, operação, undo/redo/limpar |
| congelamento da câmera | `src/raycastLasso/volumeRaycastLassoBehaviour.ts` | id → matriz, alimenta o material |
| teste por amostra | `src/raycastLasso/volumeRaycastLassoMaterial.ts` | winding number no WGSL |

## Decisões que não são óbvias

**Undo/redo é um cursor, não command pattern.** `lassos` é a lista inteira
(inclusive o que foi desfeito) e `cursor` diz quantos valem. Undo = `cursor--`.
Como o corte é 100% recalculado no shader, desfazer não reverte nada no volume —
é instantâneo por construção.

**A órbita congela no modo desenho.** O `App` monta o `LassoOverlay` *no lugar*
do `OrbitControls`, nunca os dois. É dessa invariante que a behaviour depende:
ela captura a matriz no *commit* do traço, e só está certa porque a câmera não
se mexeu desde o *começo* dele.

**A pilha morre na troca de mundo.** O polígono está no redux (que sobrevive),
mas a matriz mora no cache da behaviour (que morre com o mundo). Sem zerar, os
lassos antigos seriam re-congelados contra a câmera nova e cortariam no lugar
errado, em silêncio.

**O teste é no MEIO do segmento.** O par `(sf, sb)` endereça a tabela
pré-integrada de um segmento inteiro (Engel); cortar só uma das pontas indexaria
`T[sf][sb]` com um par que não existe mais e pintaria uma faixa de cor errada na
borda do corte.

**Winding number, não par/ímpar.** Lasso à mão livre se auto-intersecta com
frequência, e o winding é o que casa com "tudo que eu cerquei". Também funciona
nas duas orientações de traço (horário e anti-horário).

**O ESS continua correto sem saber do lasso.** O skip-map só pula o que é
comprovadamente vazio, e o lasso apenas remove *mais* coisa. Ele só não
*acelera*: um chunk inteiramente dentro do lasso ainda é marchado.

## O que ficou de fora (próximos passos)

1. **Máscara rasterizada.** Hoje o teste é um laço de arestas **por amostra de
   raio** — `passos × lassos × arestas`. O upgrade é rasterizar cada lasso numa
   textura 2D (R8) e trocar o laço por **um `textureSampleLevel`**: O(1), sem
   divergência de branch, e com borda antialiasada de brinde. Vários lassos com
   câmeras diferentes → `texture_2d_array`.

   Quando isso acontecer, vale hoistar a projeção: `M*(o + t*d) = M*o + t*(M*d)`
   é **afim em `t` no espaço homogêneo**, então dá pra calcular `A` e `B` uma vez
   por raio e deixar só um fma + um divide no laço. Hoje não compensa, porque o
   laço de arestas domina o custo.

2. **Normal da parede do corte.** O gradiente continua lendo dados *dentro* da
   região removida, então a parede é sombreada com a normal do tecido, não com a
   da parede. A saída boa é sombrear com a normal analítica da face do lasso que
   foi cruzada (o plano aresta + olho).

3. **ESS ciente do lasso.** Marcar como vazio o chunk cujos 8 cantos projetam
   todos dentro de um lasso de remoção.

4. **Bake numa máscara 3D.** Se a pilha crescer muito, um compute que grava a
   união num volume de máscara troca o laço por 1 fetch por amostra. Custa
   memória, faz stair-stepping na borda e exige re-bake no undo — plano B, não
   ponto de partida.
