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
export async function loadTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
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
    const bitmap = await createImageBitmap(await response.blob());

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
