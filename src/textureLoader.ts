//Carrega uma imagem (png/jpg/webp...) do servidor e sobe pra uma
//GPUTexture. O caminho é o rápido do browser: fetch → ImageBitmap
//(decodifica fora da main thread) → copyExternalImageToTexture.
//
//O formato é rgba8unorm-srgb: imagem de cor (diffuse) é autorada em sRGB,
//e com o sufixo -srgb a GPU converte pra linear sozinha na amostragem —
//sem ele as texturas aparecem desbotadas/claras demais.
//
//TODO: sem mipmaps por enquanto (gerar mips em WebGPU exige um pass de
//blit próprio). Superfície longe da câmera vai serrilhar um pouco.
async function fetchImageBitmap(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Falha ao baixar textura ${url}: ${response.status} ${response.statusText}`);
    }
    //Pega URL errada com resposta 200: o dev server do Vite responde
    //caminho inexistente com o index.html, e o decoder falharia com um
    //"could not be decoded" que não diz a causa.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
        throw new Error(
            `Textura ${url} não é imagem (content-type "${contentType}") — caminho errado? O arquivo existe em public/?`,
        );
    }
    //Sem colorSpaceConversion:"none": além de o Chromium falhar a decodificação
    //de imagens com perfil de cor (ICC/CMYK) com essa opção, a conversão
    //default pra sRGB é o que o formato -srgb da textura espera.
    return createImageBitmap(await response.blob());
}

export async function loadTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
    const bitmap = await fetchImageBitmap(url);

    const texture = device.createTexture({
        label: url,
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm-srgb",
        //os três usages são exigência do copyExternalImageToTexture
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
        bitmap.width,
        bitmap.height,
    ]);
    bitmap.close();
    return texture;
}

//Carrega um cubemap a partir de UMA imagem em cruz horizontal 4x3:
//
//        [+Y]                Uma textura de cubemap na GPU é uma textura
//   [-X] [+Z] [+X] [-Z]      2D com 6 layers (uma por face) que os passes
//        [-Y]                enxergam por uma view com dimension:"cube" e
//                            amostram com um vetor de DIREÇÃO no shader.
//A ordem dos layers é fixa da API: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z.
export async function loadCubemapTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
    const bitmap = await fetchImageBitmap(url);
    const face = Math.floor(bitmap.width / 4);
    if (bitmap.width !== face * 4 || bitmap.height !== face * 3) {
        throw new Error(
            `Cubemap ${url}: esperada cruz horizontal 4x3 (largura = 4×face, altura = 3×face), ` +
                `mas a imagem é ${bitmap.width}x${bitmap.height}.`,
        );
    }
    const texture = device.createTexture({
        label: url,
        size: [face, face, 6],
        format: "rgba8unorm-srgb",
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
    });
    //Célula (coluna, linha) da cruz de cada face, na ordem dos layers.
    const cells: [number, number][] = [
        [2, 1], //+X
        [0, 1], //-X
        [1, 0], //+Y
        [1, 2], //-Y
        [1, 1], //+Z
        [3, 1], //-Z
    ];
    //origin no source recorta a célula direto do bitmap da cruz — sem
    //precisar decodificar 6 bitmaps separados.
    cells.forEach(([col, row], layer) => {
        device.queue.copyExternalImageToTexture(
            { source: bitmap, origin: [col * face, row * face] },
            { texture, origin: [0, 0, layer] },
            [face, face],
        );
    });
    bitmap.close();
    return texture;
}
