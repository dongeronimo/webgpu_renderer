# WebGPU Volume Renderer v2

Renderizador de volume médico em WebGPU. Este repositório inclui o `dicom_converter.py`, o script de pré-processamento que converte séries DICOM no formato consumido pelo renderizador.

# A cena

A cena é uma árvore de Nodes. Cada Node tem sua transformação, possivelmente um pai e uma lista de filhos que pode ter zero ou N filhos. 

Em adição a isso Nodes podem ter um ou zero renderables pendurados nele. Um renderable é algo que poder ser renderizado, tendo mesh e material.

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
