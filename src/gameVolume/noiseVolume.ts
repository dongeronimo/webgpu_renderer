//Volume de RUÍDO 3D pré-calculado pra fumaça procedural. Diferente do
//syntheticVolume (fantoma em HU pro pipeline médico), aqui guardamos um FBM
//(fractal Brownian motion) tileável em r8unorm [0,1]: o raymarch do smoke
//amostra este ruído com DESLOCAMENTO por tempo (drift) pra a fumaça
//"ferver"/derivar sem precisar de nenhum compute por frame — o "muda em
//tempo real" do estágio 0 sai só de deslocar as coordenadas de amostragem.
//
//Tileável de propósito: os períodos das oitavas dividem `size` e o lattice
//faz wrap por módulo, então não há costura quando o sampler (addressMode
//"repeat") lê coordenadas deslocadas pra fora de [0,1]. O próximo estágio
//troca esta textura estática por uma atualizada por compute (advecção real).

//Hash inteiro 32-bit → [0,1). Math.imul mantém a multiplicação em 32 bits
//(o `*` de JS estoura pra double e perde os bits altos que dão o embaralhamento).
function hash01(x: number, y: number, z: number): number {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967295;
}

const smooth = (t: number): number => t * t * (3 - 2 * t); //smoothstep
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

//Value noise tileável: lattice de `period` células no cubo [0,1), com wrap
//por módulo nos cantos (por isso `period` tem que dividir o `size` da textura
//pra as células caírem exatas nos texels e a borda casar).
function valueNoise(x: number, y: number, z: number, period: number): number {
    const fx = x * period, fy = y * period, fz = z * period;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = smooth(fx - ix), ty = smooth(fy - iy), tz = smooth(fz - iz);
    const c = (a: number, b: number, d: number): number =>
        hash01((ix + a) % period, (iy + b) % period, (iz + d) % period);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx);
    const x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx);
    const x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
    return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
}

/**
 * Cria a textura 3D r8unorm do ruído FBM, size³ voxels (default 64). O World
 * é dono e a destrói; o SmokeVolumePass só a amostra.
 */
export function createNoiseVolume(device: GPUDevice, size = 64): GPUTexture {
    const data = new Uint8Array(size * size * size);
    //Períodos 4,8,16 dividem 64 → o wrap por módulo casa nas bordas (tileável).
    //Pesos 1/2,1/4,1/8 normalizados: FBM clássico, detalhe decaindo por oitava.
    const norm = 1 / (0.5 + 0.25 + 0.125);
    let i = 0;
    for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                //centro do voxel em [0,1)³
                const px = (x + 0.5) / size;
                const py = (y + 0.5) / size;
                const pz = (z + 0.5) / size;
                const f =
                    (0.5 * valueNoise(px, py, pz, 4) +
                        0.25 * valueNoise(px, py, pz, 8) +
                        0.125 * valueNoise(px, py, pz, 16)) *
                    norm;
                data[i++] = Math.round(Math.min(1, Math.max(0, f)) * 255);
            }
        }
    }

    const texture = device.createTexture({
        label: `noise volume ${size}^3`,
        size: [size, size, size],
        dimension: "3d",
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: size, rowsPerImage: size },
        [size, size, size],
    );
    return texture;
}
