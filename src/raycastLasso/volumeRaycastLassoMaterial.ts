//Material do RAYCASTER DO LASSO. Clone do VolumeRaycastESSMaterial
//(../raycastESS/) — MESMO raymarch single-pass proxy-cube, MESMA CTF
//pré-integrada (Engel), MESMO shading por gradiente, MESMO empty-space skipping
//por chunk. É o material de um WORLD NOVO de propósito: o ESS fica intacto como
//baseline de qualidade/velocidade (A/B no gpuTimer), e o corte por lasso é
//experimentado aqui sem risco pra ele.
//
//NESTA ETAPA o shader é IDÊNTICO ao do ESS — o mundo é só o andaime. O corte
//entra depois, e o plano é este:
//
//  1. Um lasso = polígono em NDC + a viewProj CONGELADA do instante do desenho.
//     Pré-multiplicada pelo model, vira M_lasso: pLocal ([-0.5,0.5]³) → clip do
//     lasso. Guardar a MATRIZ (e não um vetor de direção) é o que faz o sólido
//     removido ser a PIRÂMIDE infinita que o usuário viu na tela, e não um
//     prisma que só bate no centro da imagem.
//  2. A projeção é AFIM em t no espaço homogêneo:
//         M*(o + t*rd) = M*o + t*(M*rd) = A + t*B
//     então A e B saem UMA vez por raio (2 mat4×vec4, hoisted como o chunkCell),
//     e no laço sobra `c = A + B*t` + uma divisão. Nada de mat4 por amostra.
//  3. O teste dentro/fora: crossing-number contra os segmentos na v1; máscara 2D
//     rasterizada (1 textureSampleLevel, sem branch divergente) na v2.
//  4. Descartar o SEGMENTO, não a amostra: o laço lê sf em uvw e sb em
//     uvw+rd*step e indexa T[sf][sb]. Cortar só uma das pontas indexa um par que
//     não existe mais — faixa de cor errada na borda do corte.
//
//O ponto de entrada está marcado com "LASSO:" no laço do fragment.
//
//Bind groups: iguais aos do ESS (grupos 0/1 do frame/objeto; grupo 2 material
//com params/sampler/volume/preint/gradient/skip-map). Só aceita MeshType.Static
//(o proxy-cube).
import { bakePreIntegrationTable, PREINT_TABLE_SIZE, type CtfPoint } from "../ctf";
import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh } from "../mesh";
import type { LassoData } from "./lassoData";
import { LASSO_MASK_SIZE, rasterizeLassoMask } from "./lassoMask";

const DEFAULT_STEP_SIZE = 1 / 256;

/** Grade de chunks + lado do chunk, tudo vindo do metadata do exame. */
export interface ChunkGrid {
    numChunksX: number;
    numChunksY: number;
    numChunksZ: number;
    totalChunks: number;
    /** Lado do chunk cúbico em VOXELS. */
    chunkSize: number;
}

const RAYCAST_LASSO_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;

struct Params {
    ctfMin: f32,       //HU do primeiro ponto da CTF (início do domínio)
    ctfMax: f32,       //HU do último ponto (fim do domínio)
    alphaScale: f32,   //dilui a opacidade da CTF por passo (knob da UI)
    stepSize: f32,     //passo local ao longo do raio (espaço da caixa)
    //---
    useGradient: f32,  //>0.5 usa gradiente, else cor chapada
    gradientType: f32, //>0.5 = on-the-fly, else pré-calculado
    useSkip: f32,      //>0.5 liga o empty-space skipping (else marcha tudo)
    chunkSize: f32,    //lado do chunk em VOXELS
    //---
    spacing: vec3f,    //mm por voxel em x,y,z (vec3f alinha em 16 → offset 32)
    //Os dois campos abaixo ocupam o PADDING dos vec3f (offsets 44 e 60): vec3f
    //tem tamanho 12 e alinhamento 16, então um f32 logo depois entra no buraco
    //de graça — o uniform continua com 64 bytes.
    lassoCount: f32,   //quantos lassos vigentes (offset 44)
    //---
    numChunks: vec3f,  //nº de chunks por eixo (f32 → u32 no shader; offset 48)
    lassoDebug: f32,   //>0.5 PINTA a região dos lassos em vez de cortar (offset 60)
};
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var samp: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;
@group(2) @binding(3) var preint: texture_2d<f32>; //tabela pré-integrada T[sf][sb]
@group(2) @binding(4) var gradient: texture_3d<f32>; //o gradiente pré-calculado
@group(2) @binding(5) var<storage, read> occupied: array<u32>; //skip-map: 1=processa, 0=pula
//As máscaras dos lassos, uma CAMADA por lasso (r8unorm: 255 dentro, 0 fora),
//rasterizadas na CPU quando a lista muda — ver lassoMask.ts.
@group(2) @binding(6) var lassoMasks: texture_2d_array<f32>;
//A câmera congelada de cada lasso, na MESMA ordem das camadas: leva pLocal
//direto pro clip daquele lasso (proj·view·model, composta na CPU).
@group(2) @binding(7) var<storage, read> lassoClip: array<mat4x4f>;

const REFERENCE_SLICE_COUNT: f32 = 128.0;
const MAX_STEPS: i32 = 512;
//Nudge pra o salto de skip pousar DENTRO do próximo chunk (senão pode reler o
//mesmo e travar). Em unidades de t (rd é normalizado no espaço local, caixa=1).
const SKIP_EPS: f32 = 1e-4;

//Cor do debug das máscaras: magenta, que não existe em CT nenhuma — cinza de
//tecido e branco de osso nunca vão ser confundidos com ela.
const LASSO_DEBUG_TINT = vec3f(1.0, 0.15, 0.55);

//O ponto (espaço LOCAL do volume) cai dentro de algum lasso?
//
//Projeta com a matriz congelada daquele lasso e consulta a máscara. Sem
//hoisting de A/B pra fora do laço de propósito: com N dinâmico, os A/B
//viveriam num array de tamanho fixo indexado dinamicamente, que a GPU joga em
//memória privada (spill) — sairia mais caro que refazer a mat4×vec4 aqui.
fn insideAnyLasso(pLocal: vec3f, count: u32) -> bool {
    for (var i = 0u; i < count; i = i + 1u) {
        let c = lassoClip[i] * vec4f(pLocal, 1.0);
        //Atrás do olho congelado: projeta espelhado, cairia no polígono errado.
        if (c.w <= 0.0) {
            continue;
        }
        //NDC → uv, com o y invertido (NDC cresce pra cima, v cresce pra baixo).
        //Fora de [0,1] o clamp-to-edge devolve o anel de borda, que a
        //rasterização zera de propósito — ou seja, "fora".
        let uv = vec2f(c.x / c.w, -c.y / c.w) * 0.5 + vec2f(0.5);
        //textureSampleLevel (LOD explícito) é válido em fluxo não-uniforme;
        //textureSample não seria, e este "if" é exatamente isso.
        if (textureSampleLevel(lassoMasks, samp, uv, i, 0.0).r > 0.5) {
            return true;
        }
    }
    return false;
}

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) localPos: vec3f,
    @location(1) @interpolate(flat) instance: u32,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    out.position = frame.proj * frame.view * models[instance] * vec4f(position, 1.0);
    out.localPos = position;
    out.instance = instance;
    return out;
}

fn inverse3(m: mat3x3f) -> mat3x3f {
    let a = m[0];
    let b = m[1];
    let c = m[2];
    let r0 = cross(b, c);
    let r1 = cross(c, a);
    let r2 = cross(a, b);
    let invDet = 1.0 / dot(a, r0);
    return mat3x3f(
        vec3f(r0.x, r1.x, r2.x),
        vec3f(r0.y, r1.y, r2.y),
        vec3f(r0.z, r1.z, r2.z),
    ) * invDet;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let model = models[in.instance];
    let R = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
    let camWorld = -(transpose(R) * frame.view[3].xyz);
    let invLin = inverse3(mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz));
    let camLocal = invLin * (camWorld - model[3].xyz);
    let rd = normalize(in.localPos - camLocal);

    //Interseção raio-caixa (slab) contra [-0.5,0.5]³.
    let invD = 1.0 / rd;
    let t0 = (vec3f(-0.5) - camLocal) * invD;
    let t1 = (vec3f(0.5) - camLocal) * invD;
    let tsmall = min(t0, t1);
    let tbig = max(t0, t1);
    var tNear = max(max(tsmall.x, tsmall.y), tsmall.z);
    let tFar = min(min(tbig.x, tbig.y), tbig.z);
    tNear = max(tNear, 0.0);
    if (tFar <= tNear) {
        discard;
    }

    let step = params.stepSize;
    let opacityExponent = step * REFERENCE_SLICE_COUNT;
    let range = max(params.ctfMax - params.ctfMin, 1e-6);

    let voxel = 1.0 / vec3f(textureDimensions(volume));
    let lightPos = vec3f(5.0, 5.0, 5.0);
    let normalMatrix = transpose(invLin);

    //ESS: hoisted pra fora do laço (uniformes). chunkCell = tamanho do chunk em
    //uvw por eixo = chunkSize(voxels)/dims(voxels). O último chunk de um eixo
    //pode ser parcial (numChunks*chunkSize >= dim) — o tFar da caixa grande já
    //corta o excesso, então não precisa clamp no salto.
    let chunkCell = vec3f(params.chunkSize) / vec3f(textureDimensions(volume));
    let nChunks = vec3u(u32(params.numChunks.x), u32(params.numChunks.y), u32(params.numChunks.z));
    let nChunksMax = vec3f(nChunks) - vec3f(1.0);
    //uniforme: sai do laço
    let lassoCount = u32(params.lassoCount);

    var acc = vec4f(0.0);
    var t = tNear;
    for (var i = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= tFar) {
            break;
        }
        let pLocal = camLocal + rd * t;
        let uvw = pLocal + vec3f(0.5);

        //EMPTY-SPACE SKIPPING: chunk vazio pra CTF atual → salta pra saída da
        //caixa DESTE chunk em vez de amostrar. cidxF (não-clampado) constrói o
        //AABB; ci (clampado) indexa o skip-map sem estourar a borda.
        if (params.useSkip > 0.5) {
            let cidxF = floor(uvw / chunkCell);
            let ci = vec3u(clamp(cidxF, vec3f(0.0), nChunksMax));
            let flat = (ci.z * nChunks.y + ci.y) * nChunks.x + ci.x;
            if (occupied[flat] == 0u) {
                let loLocal = cidxF * chunkCell - vec3f(0.5);
                let hiLocal = loLocal + chunkCell;
                let tLo = (loLocal - camLocal) * invD;
                let tHi = (hiLocal - camLocal) * invD;
                let tExit = min(min(max(tLo.x, tHi.x), max(tLo.y, tHi.y)), max(tLo.z, tHi.z));
                t = tExit + SKIP_EPS;
                continue;
            }
        }

        let sf = textureSampleLevel(volume, samp, uvw, 0.0).r;
        let sb = textureSampleLevel(volume, samp, uvw + rd * step, 0.0).r;
        let uf = (sf - params.ctfMin) / range;
        let ub = (sb - params.ctfMin) / range;
        let c = textureSampleLevel(preint, samp, vec2f(uf, ub), 0.0);

        var rgb = c.rgb;
        if (params.useGradient > 0.5) {
            var gLocal = vec3f(0,0,0);
            if(params.gradientType > 0.5) {
                let gx = (textureSampleLevel(volume, samp, uvw + vec3f(voxel.x, 0.0, 0.0), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(voxel.x, 0.0, 0.0), 0.0).r) / (2.0 * params.spacing.x);
                let gy = (textureSampleLevel(volume, samp, uvw + vec3f(0.0, voxel.y, 0.0), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(0.0, voxel.y, 0.0), 0.0).r) / (2.0 * params.spacing.y);
                let gz = (textureSampleLevel(volume, samp, uvw + vec3f(0.0, 0.0, voxel.z), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(0.0, 0.0, voxel.z), 0.0).r) / (2.0 * params.spacing.z);
                gLocal = vec3f(gx, gy, gz);
            }
            else {
                let dHU = textureSampleLevel(gradient, samp, uvw, 0.0);
                gLocal = dHU.xyz * 2.0 - 1.0;
            }

            if (length(gLocal) > 0.001) {
                let N = normalize(normalMatrix * (-gLocal));
                let pWorld = (model * vec4f(pLocal, 1.0)).xyz;
                let L = normalize(lightPos - pWorld);
                let V = normalize(camWorld - pWorld);
                let H = normalize(L + V);
                let diffuse = max(dot(N, L), 0.0);
                let specular = pow(max(dot(N, H), 0.0), 32.0);
                let ambient = 0.2;
                rgb = c.rgb * (ambient + (1.0 - ambient) * diffuse) + vec3f(0.3 * specular);
            }
        }

        //LASSO (debug): pinta o que SERIA removido, em vez de remover. O corte
        //de verdade é a mesma condição com "t = t + step; continue;" no lugar
        //do mix — e é só isso que falta.
        //
        //O ponto de teste é o MÉDIO do segmento, e não pLocal: a CTF
        //pré-integrada consome o segmento inteiro (sf em uvw, sb em uvw+rd*step)
        //e indexa T[sf][sb], então o corte terá que descartar o SEGMENTO, não a
        //amostra. Testando o mesmo ponto agora, o que o debug pinta é
        //exatamente o que vai sumir depois.
        if (params.lassoDebug > 0.5 && lassoCount > 0u) {
            if (insideAnyLasso(pLocal + rd * (step * 0.5), lassoCount)) {
                rgb = mix(rgb, LASSO_DEBUG_TINT, 0.75);
            }
        }

        let aRef = clamp(c.a * params.alphaScale, 0.0, 1.0);
        let alpha = 1.0 - pow(1.0 - aRef, opacityExponent);
        let w = (1.0 - acc.a) * alpha;
        acc = vec4f(acc.rgb + w * rgb, acc.a + w);
        if (acc.a >= 0.995) {
            break;
        }
        t = t + step;
    }
    return acc;
}
`;

export class VolumeRaycastLassoMaterial extends Material {
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "VolumeRaycastLassoMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    //o skip-map: storage read-only no fragment (igual aos models do grupo 1)
                    { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                    //máscaras dos lassos (1 camada por lasso) + as matrizes congeladas
                    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
                    { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                ],
            });
        }
        return this.materialLayout;
    }

    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "VolumeRaycastLassoMaterial sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
                addressModeW: "clamp-to-edge",
            });
        }
        return this.sampler;
    }

    private static createPipeline(ctx: PipelineContext): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "VolumeRaycastLassoMaterial shader",
                code: RAYCAST_LASSO_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "VolumeRaycastLassoMaterial (Static)",
            layout: device.createPipelineLayout({
                label: "VolumeRaycastLassoMaterial pipeline layout",
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [StaticMesh.vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: ctx.colorFormat,
                        blend: {
                            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "front" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: false,
                depthCompare: "less-equal",
            },
        });
    }

    private readonly device: GPUDevice;
    private readonly volumeTexture: GPUTexture;
    private readonly preintTexture: GPUTexture;
    private readonly gradientTexture: GPUTexture;
    private readonly paramsBuffer: GPUBuffer;
    //o skip-map (1 u32/chunk); a CPU o preenche via setSkipMap
    private readonly occupiedBuffer: GPUBuffer;
    //Os recursos dos lassos são RECRIADOS a cada mudança da lista (o número de
    //camadas de um texture_2d_array é fixo na criação), e por isso o bind group
    //também é — nada disso pode ser readonly.
    private lassoMaskTexture!: GPUTexture;
    private lassoClipBuffer!: GPUBuffer;
    private bindGroup!: GPUBindGroup;
    private ctfMin = 0;
    private ctfMax = 1;
    private alphaScale: number;
    private readonly stepSize: number;
    private useGradient: number;
    private gradientType: number;
    private useSkip: number;
    private lassoDebug = 0;
    //Os lassos vigentes. Guardados como VIERAM (a lista do redux é imutável:
    //o reducer cria array novo a cada mudança), pra o rebuild dos recursos de
    //GPU ter de onde partir sem depender de quem chamou.
    private lassos: readonly LassoData[] = [];
    private readonly spacing: [number, number, number];
    private readonly numChunksX: number;
    private readonly numChunksY: number;
    private readonly numChunksZ: number;
    private readonly chunkSizeVoxels: number;

    /**
     * O material só AMOSTRA volumeTexture e gradientTexture; a posse (destroy) é
     * de quem as criou — o RaycastLassoWorld. O skip-map (occupiedBuffer) é do
     * material (ele o aloca e o destrói).
     */
    constructor(
        device: GPUDevice,
        volumeTexture: GPUTexture,
        gradientTexture: GPUTexture,
        /** mm por voxel [x,y,z] do exame (gradientParamsFromMetadata.spacing). */
        spacing: [number, number, number],
        /** Pontos de controle da CTF, ordenados por HU (ver ctf.ts). */
        ctfPoints: readonly CtfPoint[],
        /** Grade de chunks do exame (metadata) — dimensiona o skip-map + índice. */
        chunkGrid: ChunkGrid,
        alphaScale = 0.3,
        gradientShading = false,
        gradientType = 1,
        emptySpaceSkip = true,
        stepSize = DEFAULT_STEP_SIZE,
    ) {
        super();
        this.device = device;
        this.volumeTexture = volumeTexture;
        this.gradientTexture = gradientTexture;
        this.spacing = spacing;
        this.alphaScale = alphaScale;
        this.useGradient = gradientShading ? 1 : 0;
        this.gradientType = gradientType;
        this.useSkip = emptySpaceSkip ? 1 : 0;
        this.stepSize = stepSize;
        this.numChunksX = chunkGrid.numChunksX;
        this.numChunksY = chunkGrid.numChunksY;
        this.numChunksZ = chunkGrid.numChunksZ;
        this.chunkSizeVoxels = chunkGrid.chunkSize;

        this.paramsBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial params",
            //struct Params: spacing:vec3f e numChunks:vec3f alinham em 16 → 64
            //bytes (16 floats, padding nos índices 11 e 15 — ver writeParams)
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.preintTexture = device.createTexture({
            label: "VolumeRaycastLassoMaterial preintegration table",
            size: [PREINT_TABLE_SIZE, PREINT_TABLE_SIZE, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.occupiedBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial skip-map (occupied)",
            size: Math.max(chunkGrid.totalChunks, 1) * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        //default seguro: tudo ocupado (processa tudo) até o world/behaviour
        //mandarem o skip-map de verdade — assim nada é pulado por engano.
        this.setSkipMap(new Uint32Array(chunkGrid.totalChunks).fill(1));
        this.setCtf(ctfPoints); //bakeia a tabela + escreve os params

        //Sem lasso nenhum ainda, mas o layout exige os recursos: nascem no
        //tamanho mínimo (1 camada de 1×1) e o world/behaviour os trocam.
        this.createLassoResources([]);
        this.rebuildBindGroup();
    }

    /**
     * (Re)cria a textura de máscaras e o buffer de matrizes pra lista dada.
     * Uma camada por lasso; SEM lasso, uma camada de 1×1 zerada — o bind group
     * layout exige os dois recursos existindo, mesmo vazios, e alocar 512² pra
     * nada seria desperdício.
     */
    private createLassoResources(lassos: readonly LassoData[]): void {
        const layers = Math.max(lassos.length, 1);
        const size = lassos.length > 0 ? LASSO_MASK_SIZE : 1;
        this.lassoMaskTexture = this.device.createTexture({
            label: "VolumeRaycastLassoMaterial lasso masks",
            size: [size, size, layers],
            dimension: "2d",
            format: "r8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        //Rasterização na CPU, uma vez por lasso por edição — alguns ms, e só
        //quando a referência da lista troca (a behaviour é quem detecta).
        for (let i = 0; i < lassos.length; i++) {
            const mask = rasterizeLassoMask(lassos[i].points, LASSO_MASK_SIZE);
            this.device.queue.writeTexture(
                { texture: this.lassoMaskTexture, origin: [0, 0, i] },
                mask,
                { bytesPerRow: LASSO_MASK_SIZE, rowsPerImage: LASSO_MASK_SIZE },
                [LASSO_MASK_SIZE, LASSO_MASK_SIZE, 1],
            );
        }
        //As matrizes na mesma ordem das camadas: o índice do laço do shader
        //serve pros dois.
        const matrices = new Float32Array(layers * 16);
        for (let i = 0; i < lassos.length; i++) {
            matrices.set(lassos[i].clipFromLocal, i * 16);
        }
        this.lassoClipBuffer = this.device.createBuffer({
            label: "VolumeRaycastLassoMaterial lasso matrices",
            size: matrices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.lassoClipBuffer, 0, matrices);
    }

    private rebuildBindGroup(): void {
        this.bindGroup = this.device.createBindGroup({
            label: "VolumeRaycastLassoMaterial instance",
            layout: VolumeRaycastLassoMaterial.getMaterialBindGroupLayout(this.device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: VolumeRaycastLassoMaterial.getSampler(this.device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: this.preintTexture.createView() },
                { binding: 4, resource: this.gradientTexture.createView({ dimension: "3d" }) },
                { binding: 5, resource: { buffer: this.occupiedBuffer } },
                { binding: 6, resource: this.lassoMaskTexture.createView({ dimension: "2d-array" }) },
                { binding: 7, resource: { buffer: this.lassoClipBuffer } },
            ],
        });
    }

    setCtf(points: readonly CtfPoint[]): void {
        const baked = bakePreIntegrationTable(points);
        this.ctfMin = baked.huMin;
        this.ctfMax = baked.huMax;
        this.device.queue.writeTexture(
            { texture: this.preintTexture },
            baked.data,
            { bytesPerRow: baked.size * 4, rowsPerImage: baked.size },
            [baked.size, baked.size, 1],
        );
        this.writeParams();
    }

    setAlphaScale(alphaScale: number): void {
        this.alphaScale = alphaScale;
        this.writeParams();
    }

    setGradientShading(enabled: boolean, onTheFly: boolean): void {
        this.useGradient = enabled ? 1 : 0;
        this.gradientType = onTheFly ? 1 : 0;
        this.writeParams();
    }

    /** Liga/desliga o empty-space skipping (pra A/B de velocidade). */
    setEmptySpaceSkip(enabled: boolean): void {
        this.useSkip = enabled ? 1 : 0;
        this.writeParams();
    }

    /**
     * Reescreve o skip-map inteiro (1 u32/chunk, 1=processa/0=pula). Chamado
     * pelo world na criação e pela behaviour toda vez que a CTF muda. O array
     * tem que ter totalChunks elementos, na ordem row-major (z,y,x).
     */
    setSkipMap(occupied: Uint32Array<ArrayBuffer>): void {
        this.device.queue.writeBuffer(this.occupiedBuffer, 0, occupied);
    }

    /**
     * Troca a lista de lassos vigente. Chamado pelo world na criação (a lista
     * sobrevive à troca de mundo, então um world novo pode já nascer com
     * lassos) e pela behaviour toda vez que a referência do array muda.
     *
     * Rasteriza as máscaras, refaz o array de matrizes e RECRIA o bind group
     * (as camadas do texture_2d_array são fixas na criação, então mudar de
     * quantidade é destruir e criar de novo — acontece uma vez por edição do
     * usuário, não por frame).
     *
     * Roda no update() da behaviour, nunca no meio de um frame: o main chama
     * update() antes de render(), então o bind group novo já vale no frame que
     * está sendo montado.
     */
    setLassos(lassos: readonly LassoData[]): void {
        this.lassos = lassos;
        this.lassoMaskTexture.destroy();
        this.lassoClipBuffer.destroy();
        this.createLassoResources(lassos);
        this.rebuildBindGroup();
        this.writeParams(); //lassoCount mudou
    }

    /** Debug view das máscaras: pinta a região dos lassos em vez de removê-la. */
    setLassoDebug(enabled: boolean): void {
        this.lassoDebug = enabled ? 1 : 0;
        this.writeParams();
    }

    /** Quantos lassos estão vigentes (o shader vai precisar do mesmo número). */
    get lassoCount(): number {
        return this.lassos.length;
    }

    private writeParams(): void {
        //struct Params (uniform std140-ish): spacing:vec3f no byte 32 (índice 8),
        //numChunks:vec3f no byte 48 (índice 12). Os índices 11 e 15, que eram
        //padding dos vec3f, hoje carregam lassoCount e lassoDebug.
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([
                this.ctfMin, this.ctfMax, this.alphaScale, this.stepSize,
                this.useGradient, this.gradientType, this.useSkip, this.chunkSizeVoxels,
                this.spacing[0], this.spacing[1], this.spacing[2], this.lassos.length,
                this.numChunksX, this.numChunksY, this.numChunksZ, this.lassoDebug,
            ]),
        );
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Static) {
            throw new Error(
                `VolumeRaycastLassoMaterial só desenha MeshType.Static (o proxy-cube), recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!VolumeRaycastLassoMaterial.pipeline) {
            VolumeRaycastLassoMaterial.pipeline = VolumeRaycastLassoMaterial.createPipeline(ctx);
        }
        return VolumeRaycastLassoMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /**
     * O buffer do skip-map (1 u32/chunk). O DebugChunksPass o lê pra saber
     * quais chunks desenhar — MESMA fonte de verdade, atualiza junto quando a
     * behaviour chama setSkipMap na mudança de CTF.
     */
    get skipMapBuffer(): GPUBuffer {
        return this.occupiedBuffer;
    }

    override destroy(): void {
        this.volumeTexture.destroy();
        this.preintTexture.destroy();
        this.paramsBuffer.destroy();
        this.occupiedBuffer.destroy();
        this.lassoMaskTexture.destroy();
        this.lassoClipBuffer.destroy();
    }
}
