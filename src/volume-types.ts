/**
 * Tipos correspondentes à saída do dicom_converter.py.
 *
 * O conversor gera três artefatos por série:
 *   - slice_NNNN.raw       — fatias float16 cruas (2 bytes/voxel), uma por arquivo
 *   - chunk_histograms.bin — histogramas uint32 por chunk (empty space skipping)
 *   - metadata.json        — este arquivo, tipado por VolumeMetadata
 */

/**
 * Valor de tag DICOM serializado pelo conversor.
 *
 * Tags multivalor (ex.: PixelSpacing, ImageOrientationPatient) viram string[];
 * tags simples viram string; tags ausentes viram "" (string vazia).
 * Os números vêm como string porque o DICOM os representa como texto decimal —
 * converta com parseFloat/Number no ponto de uso.
 */
export type DicomTagValue = string | string[];

/** Conteúdo do metadata.json gerado pelo conversor. */
export interface VolumeMetadata {
  // ---- Dimensões e formato do volume ----

  /** Número de fatias (dimensão Z do volume). */
  numSlices: number;
  /** Largura de cada fatia em voxels (dimensão X). */
  width: number;
  /** Altura de cada fatia em voxels (dimensão Y). */
  height: number;
  /** Formato dos voxels nos arquivos slice_NNNN.raw. Sempre "float16". */
  format: "float16";
  /** Bytes por voxel nos .raw. Sempre 2 (float16). */
  bytesPerVoxel: number;
  /** true se os identificadores do paciente foram substituídos por hashes. */
  anonymized: boolean;

  // ---- Paciente (hasheados se anonymized === true) ----

  /** Nome do paciente. Anonimizado: "ANON_<hash de 16 chars>". */
  patientName: string;
  /** ID do paciente. Anonimizado: "ID_<hash de 16 chars>". */
  patientID: string;
  /** Data de nascimento (YYYYMMDD). ⚠ NÃO é anonimizada. */
  patientBirthDate: string;
  /** Sexo do paciente (M/F/O). ⚠ NÃO é anonimizado. */
  patientSex: string;

  // ---- Estudo ----

  /** Data do estudo (YYYYMMDD). */
  studyDate: string;
  /** Hora do estudo (HHMMSS.frac). */
  studyTime: string;
  /** Descrição livre do estudo. */
  studyDescription: string;
  /** UID do estudo. Anonimizado: "STUDY_<hash>". */
  studyInstanceUID: string;

  // ---- Série ----

  /** Número da série dentro do estudo. */
  seriesNumber: string;
  /** Descrição livre da série. */
  seriesDescription: string;
  /** UID da série. Anonimizado: "SERIES_<hash>". */
  seriesInstanceUID: string;
  /** Modalidade do exame (CT, MR, ...). */
  modality: string;

  // ---- Geometria da imagem ----

  /** Espaçamento [linha, coluna] entre centros de pixels, em mm. Par de strings decimais. */
  pixelSpacing: DicomTagValue;
  /** Espessura da fatia em mm (string decimal). */
  sliceThickness: string;
  /** Cossenos diretores dos eixos da imagem no espaço do paciente (6 strings decimais). */
  imageOrientationPatient: DicomTagValue;
  /** Posição do primeiro voxel da primeira fatia no espaço do paciente, em mm (3 strings decimais). */
  imagePositionPatient: DicomTagValue;

  // ---- Window/Level sugerido para exibição ----

  /** Centro da janela em HU. Pode ser multivalor (várias janelas predefinidas). */
  windowCenter: DicomTagValue;
  /** Largura da janela em HU. Pode ser multivalor, pareado com windowCenter. */
  windowWidth: DicomTagValue;

  // ---- Rescale (já aplicado aos voxels pelo conversor) ----

  /** RescaleSlope original. Informativo: os .raw já estão em HU. */
  rescaleSlope: string;
  /** RescaleIntercept original. Informativo: os .raw já estão em HU. */
  rescaleIntercept: string;

  // ---- Faixa de valores ----

  /** Menor valor HU do volume, medido ANTES da suavização. */
  huMin: number;
  /** Maior valor HU do volume, medido ANTES da suavização. */
  huMax: number;

  // ---- Chunks e histogramas (empty space skipping) ----

  /** Lado do chunk cúbico em voxels (múltiplo de 16). */
  chunkSize: number;
  /** Número de chunks no eixo X = ceil(width / chunkSize). */
  numChunksX: number;
  /** Número de chunks no eixo Y = ceil(height / chunkSize). */
  numChunksY: number;
  /** Número de chunks no eixo Z = ceil(numSlices / chunkSize). */
  numChunksZ: number;
  /** numChunksX * numChunksY * numChunksZ. */
  totalChunks: number;
  /** Número de bins do histograma de cada chunk. */
  histogramBins: number;
  /**
   * Borda inferior do intervalo de binning, em HU. Medido APÓS a suavização,
   * então nenhum voxel do volume final cai fora de [histogramMin, histogramMax].
   */
  histogramMin: number;
  /** Borda superior do intervalo de binning, em HU (pós-suavização). */
  histogramMax: number;
  /** Tipo dos contadores no chunk_histograms.bin. Sempre "uint32". */
  histogramDtype: "uint32";
}

/**
 * Conteúdo do chunk_histograms.bin já carregado em memória.
 *
 * O arquivo é um array denso uint32 little-endian com shape lógico
 * (numChunksZ, numChunksY, numChunksX, histogramBins) em ordem C (row-major).
 * Carregue com: new Uint32Array(await (await fetch(url)).arrayBuffer())
 *
 * Regra de skip: um chunk pode ser pulado sse todos os bins com contagem > 0
 * mapeiam para opacidade zero na transfer function atual. O bin b cobre a
 * faixa de HU [histogramMin + b*binWidth, histogramMin + (b+1)*binWidth),
 * onde binWidth = (histogramMax - histogramMin) / histogramBins.
 * (O último bin também inclui o valor histogramMax, fechado à direita.)
 */
export interface ChunkHistograms {
  /** Contadores crus, totalChunks * histogramBins elementos. */
  counts: Uint32Array;
  /** Dimensões da grade de chunks, copiadas do metadata. */
  numChunksX: number;
  numChunksY: number;
  numChunksZ: number;
  /** Bins por chunk, copiado do metadata. */
  histogramBins: number;
  /** Intervalo de binning em HU, copiado do metadata. */
  histogramMin: number;
  histogramMax: number;
}

/**
 * Índice do primeiro bin do chunk (x, y, z) dentro de ChunkHistograms.counts.
 * O histograma do chunk ocupa counts[offset .. offset + histogramBins).
 */
export function chunkHistogramOffset(
  h: ChunkHistograms,
  x: number,
  y: number,
  z: number,
): number {
  return ((z * h.numChunksY + y) * h.numChunksX + x) * h.histogramBins;
}
