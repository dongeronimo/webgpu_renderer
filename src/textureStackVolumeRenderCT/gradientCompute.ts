//Compute do GRADIENTE dos HU: recebe a textura 3D r16float do volume
//(a mesma do loadVolumeTexture) e devolve uma textura 3D rgba8unorm do
//mesmo tamanho onde:
//  - rgb = DIREÇÃO do gradiente, normalizada e reempacotada de [-1,1]
//    pra [0,1] (decodifica com rgb*2-1 no shader que consumir);
//  - a   = MAGNITUDE, em HU/mm, dividida por maxMagnitude e clampada
//    em [0,1].
//
//O gradiente é por DIFERENÇA CENTRAL, dividida pelo spacing físico de
//cada eixo (voxel de CT é anisotrópico — sem isso a direção entorta no
//eixo z, que costuma ser mais grosso). Nas bordas o clamp da coordenada
//degenera pra diferença unilateral com metade do peso — bom o bastante,
//borda de exame é ar.
//
//É UMA função, de propósito: roda uma vez no carregamento do mundo,
//enfileira um dispatch e devolve a textura já utilizável (a ordem da
//queue garante que o compute termina antes de qualquer pass que a
//sampleie). Quem chama é dono da textura e a destrói. Sem classe, sem
//registry de computes — quando houver mais casos a gente generaliza.
import { dicomTagNumber, type VolumeMetadata } from "../volume-types";

const GRADIENT_WGSL = /* wgsl */ `
struct Params {
    spacing: vec3f,       //mm por voxel em x, y, z
    maxMagnitude: f32,    //HU/mm que mapeia pra a = 1.0
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var hu: texture_3d<f32>;
@group(0) @binding(2) var grad: texture_storage_3d<rgba8unorm, write>;

//leitura com clamp manual: textureLoad não tem sampler, então a borda
//é responsabilidade nossa
fn huAt(p: vec3i, dims: vec3i) -> f32 {
    return textureLoad(hu, clamp(p, vec3i(0), dims - vec3i(1)), 0).r;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = vec3i(textureDimensions(hu));
    let p = vec3i(gid);
    //o dispatch arredonda pra cima em grupos de 4: os invocations que
    //caem fora do volume só saem
    if (any(p >= dims)) {
        return;
    }
    //diferença central; /(2*spacing) põe em HU/mm
    let gx = (huAt(p + vec3i(1, 0, 0), dims) - huAt(p - vec3i(1, 0, 0), dims)) / (2.0 * params.spacing.x);
    let gy = (huAt(p + vec3i(0, 1, 0), dims) - huAt(p - vec3i(0, 1, 0), dims)) / (2.0 * params.spacing.y);
    let gz = (huAt(p + vec3i(0, 0, 1), dims) - huAt(p - vec3i(0, 0, 1), dims)) / (2.0 * params.spacing.z);
    let g = vec3f(gx, gy, gz);
    let mag = length(g);
    //região homogênea não tem direção: fica (0.5, 0.5, 0.5), que
    //decodifica pra vetor nulo — o consumidor decide o que fazer com
    //a = 0 (tipicamente: não ilumina)
    var dir = vec3f(0.0);
    if (mag > 1e-6) {
        dir = g / mag;
    }
    textureStore(grad, p, vec4f(dir * 0.5 + 0.5, saturate(mag / params.maxMagnitude)));
}
`;

//pipeline e layout são por SHADER, não por volume — cache de módulo,
//no mesmo espírito dos statics do TextureStackTransparentMaterial
let pipeline: GPUComputePipeline | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;

function getPipeline(device: GPUDevice): GPUComputePipeline {
    if (!pipeline) {
        bindGroupLayout = device.createBindGroupLayout({
            label: "gradientCompute",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: "float", viewDimension: "3d" },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { format: "rgba8unorm", viewDimension: "3d" },
                },
            ],
        });
        pipeline = device.createComputePipeline({
            label: "gradientCompute",
            layout: device.createPipelineLayout({
                label: "gradientCompute",
                bindGroupLayouts: [bindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({ label: "gradientCompute", code: GRADIENT_WGSL }),
                entryPoint: "main",
            },
        });
    }
    return pipeline;
}

export interface GradientComputeParams {
    /**
     * mm por voxel [x, y, z] — no CT: [pixelSpacing[1], pixelSpacing[0],
     * sliceThickness] (a MESMA convenção do cálculo de physX/Y/Z no
     * mundo). Use [1,1,1] pra volume sintético/isotrópico.
     */
    spacing: [number, number, number];
    /**
     * Magnitude (HU/mm) que satura o canal a em 1. Um chute que funciona:
     * (huMax - huMin do metadata) / menor spacing — a transição mais dura
     * possível entre dois voxels vizinhos.
     */
    maxMagnitude: number;
}

/**
 * Extrai os params do metadata do exame: as tags DICOM vêm como STRING
 * (o conversor as serializa como texto decimal — ver volume-types.ts),
 * então aqui mora o parseFloat + fallback. Eixo sem spacing válido cai
 * pra 1 mm (mesmo espírito do Number.isFinite no cálculo de physX/Y/Z
 * do mundo: metadata capenga degrada pra isotrópico, não quebra).
 * Lembrando a convenção: pixelSpacing DICOM é [entre LINHAS (y), entre
 * COLUNAS (x)] — por isso os índices trocados.
 */
export function gradientParamsFromMetadata(metadata: VolumeMetadata): GradientComputeParams {
    const sx = dicomTagNumber(metadata.pixelSpacing, 1);
    const sy = dicomTagNumber(metadata.pixelSpacing, 0);
    const sz = dicomTagNumber(metadata.sliceThickness);
    const spacing: [number, number, number] = [
        Number.isFinite(sx) && sx > 0 ? sx : 1,
        Number.isFinite(sy) && sy > 0 ? sy : 1,
        Number.isFinite(sz) && sz > 0 ? sz : 1,
    ];
    //a transição mais dura possível: a faixa inteira de HU do exame
    //entre dois voxels do eixo mais fino. Range degenerado (huMin ===
    //huMax) cai pros 4000 HU do CT típico pra não dividir por zero.
    const huRange = metadata.huMax > metadata.huMin ? metadata.huMax - metadata.huMin : 4000;
    return {
        spacing,
        maxMagnitude: huRange / Math.min(...spacing),
    };
}

/**
 * Cria a textura de gradiente do volume e enfileira o compute que a
 * preenche. Devolve na hora — a textura pode ir direto pra um bind group;
 * a ordem de submissão da queue garante que o compute roda antes do
 * primeiro sample. O CHAMADOR é dono da textura devolvida (destroy).
 */
export function createGradientTexture(
    device: GPUDevice,
    huTexture: GPUTexture,
    params: GradientComputeParams,
): GPUTexture {
    const { width, height, depthOrArrayLayers: depth } = huTexture;
    const gradientTexture = device.createTexture({
        label: `gradient de ${huTexture.label} (${width}x${height}x${depth})`,
        size: [width, height, depth],
        dimension: "3d",
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    //uniform descartável: 16 bytes, vive só até o fim deste submit
    const paramsBuffer = device.createBuffer({
        label: "gradientCompute params",
        size: 16, //vec3f + f32, alinhamento exato
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
        paramsBuffer,
        0,
        new Float32Array([...params.spacing, params.maxMagnitude]),
    );

    const computePipeline = getPipeline(device);
    const bindGroup = device.createBindGroup({
        label: "gradientCompute",
        layout: bindGroupLayout!,
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: huTexture.createView({ dimension: "3d" }) },
            { binding: 2, resource: gradientTexture.createView({ dimension: "3d" }) },
        ],
    });

    const encoder = device.createCommandEncoder({ label: "gradientCompute" });
    const pass = encoder.beginComputePass({ label: "gradientCompute" });
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, bindGroup);
    //workgroup 4×4×4: um dispatch cobre o volume inteiro (512³/4 = 128
    //grupos por eixo, longe do limite de 65535)
    pass.dispatchWorkgroups(
        Math.ceil(width / 4),
        Math.ceil(height / 4),
        Math.ceil(depth / 4),
    );
    pass.end();
    device.queue.submit([encoder.finish()]);
    paramsBuffer.destroy(); //seguro: destroy só efetiva depois do submit em voo

    return gradientTexture;
}
