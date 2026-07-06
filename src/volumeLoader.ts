//Loader da saída do dicom_converter.py: metadata.json + slice_NNNN.raw
//(float16 cru, 2 bytes/voxel) → texture_3d r16float com os HU como estão
//nos arquivos. r16float de propósito: é filterable (sampler linear
//funciona), diferente de r32float.
//
//É agnóstico de técnica — o VR por fatias e o raycaster futuro carregam
//pelo mesmo caminho; o que muda é quem consome a textura. Os histogramas
//de chunk (empty space skipping) NÃO são carregados aqui — são assunto do
//raycaster, quando chegar lá.
//
//Cada fatia é gravada na sua layer z via writeTexture assim que o fetch
//dela chega — nunca existe o volume inteiro (~centenas de MB) montado em
//um array só na RAM. O browser é quem limita a concorrência dos fetches.
import type { VolumeMetadata } from "./volume-types";

/**
 * Carrega o volume convertido que mora em `baseUrl` (ex.:
 * "/volumes/abdomen-feet-first"). Devolve a textura E o metadata — quem
 * chama precisa dele pra window/level sugerido e proporções físicas.
 */
export async function loadVolumeTexture(
    device: GPUDevice,
    baseUrl: string,
): Promise<{ texture: GPUTexture; metadata: VolumeMetadata }> {
    //---- metadata ----
    const metaResponse = await fetch(`${baseUrl}/metadata.json`);
    if (!metaResponse.ok) {
        throw new Error(`Falha ao buscar ${baseUrl}/metadata.json: HTTP ${metaResponse.status}`);
    }
    //mesma pegadinha do textureLoader: o dev server do Vite responde 200 +
    //index.html pra caminho inexistente — o content-type denuncia
    const contentType = metaResponse.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
        throw new Error(
            `${baseUrl}/metadata.json não existe (o Vite devolveu o index.html no lugar).`,
        );
    }
    const metadata = (await metaResponse.json()) as VolumeMetadata;
    if (metadata.format !== "float16" || metadata.bytesPerVoxel !== 2) {
        throw new Error(
            `Volume em formato inesperado: ${metadata.format}/${metadata.bytesPerVoxel}B — o loader só entende float16.`,
        );
    }

    const { width, height, numSlices } = metadata;
    const maxDim = device.limits.maxTextureDimension3D;
    if (width > maxDim || height > maxDim || numSlices > maxDim) {
        throw new Error(
            `Volume ${width}×${height}×${numSlices} excede maxTextureDimension3D=${maxDim} do device.`,
        );
    }

    //---- textura ----
    const texture = device.createTexture({
        label: `volume ${baseUrl} (${width}x${height}x${numSlices})`,
        size: [width, height, numSlices],
        dimension: "3d",
        format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    //---- fatias, cada uma direto pra sua layer z ----
    const sliceBytes = width * height * 2;
    let loaded = 0;
    const startTime = performance.now();
    try {
        await Promise.all(
            Array.from({ length: numSlices }, async (_, z) => {
                const url = `${baseUrl}/slice_${String(z).padStart(4, "0")}.raw`;
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Falha ao buscar ${url}: HTTP ${response.status}`);
                }
                const data = await response.arrayBuffer();
                //valida o tamanho — pega fatia truncada E o fallback
                //index.html do Vite de uma vez
                if (data.byteLength !== sliceBytes) {
                    throw new Error(
                        `${url}: esperados ${sliceBytes} bytes (${width}×${height}×2), vieram ${data.byteLength}.`,
                    );
                }
                device.queue.writeTexture(
                    { texture, origin: [0, 0, z] },
                    data,
                    { bytesPerRow: width * 2, rowsPerImage: height },
                    [width, height, 1],
                );
                loaded++;
                if (loaded % 64 === 0 || loaded === numSlices) {
                    console.log(`loadVolumeTexture: ${loaded}/${numSlices} fatias`);
                }
            }),
        );
    } catch (e) {
        texture.destroy(); //não vaza a textura (grande!) se uma fatia falhar
        throw e;
    }
    const seconds = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(
        `loadVolumeTexture: ${baseUrl} carregado em ${seconds}s ` +
        `(${((numSlices * sliceBytes) / (1024 * 1024)).toFixed(0)} MB, HU [${metadata.huMin}, ${metadata.huMax}])`,
    );

    return { texture, metadata };
}
