//Volume sintético procedural pra desenvolver/testar o VR sem depender de
//um exame convertido: um "fantoma" (phantom, no jargão de imagem médica)
//com valores em HU de verdade, pra que o window/level do material se
//comporte como se comportaria com um CT real:
//  - fundo: ar (-1000 HU)
//  - esfera grande: tecido mole (+40 HU)
//  - esfera interna deslocada: osso (+1000 HU)
//  - esfera pequena no lado oposto: cavidade de ar (-1000 HU)
//As bordas são suavizadas ao longo de ~2 voxels — imita o partial volume
//effect do scanner e evita serrilhado duro no sampling linear.
//
//Mesmo formato que o loader real usará: texture_3d r16float com HU cru.

/** Converte um float32 pros bits de um float16 (IEEE 754 half). */
function floatToHalfBits(value: number): number {
    F32_SCRATCH[0] = value;
    const x = U32_SCRATCH[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) {
        return sign | 0x7c00 | (mant ? 1 : 0); //Inf/NaN
    }
    const e = exp - 127 + 15; //rebias do expoente: 8 bits → 5 bits
    if (e >= 31) {
        return sign | 0x7c00; //overflow → Inf
    }
    if (e <= 0) {
        if (e < -10) {
            return sign; //muito pequeno → zero
        }
        mant |= 0x800000; //denormal: bit implícito vira explícito
        return sign | (mant >> (14 - e));
    }
    return sign | (e << 10) | (mant >> 13);
}
const F32_SCRATCH = new Float32Array(1);
const U32_SCRATCH = new Uint32Array(F32_SCRATCH.buffer);

/**
 * Cria a textura 3D r16float do fantoma, size³ voxels.
 * Coordenadas normalizadas: o volume ocupa [0,1]³ (o uvw das fatias).
 */
export function createSyntheticVolume(device: GPUDevice, size = 128): GPUTexture {
    const AIR = -1000;
    const SOFT_TISSUE = 40;
    const BONE = 1000;

    //mistura suave na casca da esfera: 0 dentro, 1 fora, transição de
    //~2 voxels de espessura centrada no raio
    const feather = 2 / size;
    const shell = (dist: number, radius: number): number => {
        const t = (dist - radius) / feather + 0.5;
        const c = Math.min(1, Math.max(0, t));
        return c * c * (3 - 2 * c); //smoothstep
    };

    const data = new Uint16Array(size * size * size);
    let i = 0;
    for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                //centro do voxel em [0,1]³
                const px = (x + 0.5) / size;
                const py = (y + 0.5) / size;
                const pz = (z + 0.5) / size;

                //tecido mole: esfera grande no centro
                const dTissue = Math.hypot(px - 0.5, py - 0.5, pz - 0.5);
                let hu = AIR + (SOFT_TISSUE - AIR) * (1 - shell(dTissue, 0.42));

                //osso: esfera deslocada pra +x
                const dBone = Math.hypot(px - 0.62, py - 0.5, pz - 0.5);
                hu = hu + (BONE - hu) * (1 - shell(dBone, 0.16));

                //cavidade de ar: esfera pequena deslocada pra -x
                const dCavity = Math.hypot(px - 0.32, py - 0.5, pz - 0.5);
                hu = hu + (AIR - hu) * (1 - shell(dCavity, 0.09));

                data[i++] = floatToHalfBits(hu);
            }
        }
    }

    const texture = device.createTexture({
        label: `synthetic volume ${size}^3`,
        size: [size, size, size],
        dimension: "3d",
        format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: size * 2, rowsPerImage: size },
        [size, size, size],
    );
    return texture;
}
