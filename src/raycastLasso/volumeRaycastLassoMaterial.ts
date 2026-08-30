//Material do RAYCASTER com LASSO DE REMOÇÃO. Clone do VolumeRaycastESSMaterial
//(../raycastESS/) — MESMO raymarch single-pass proxy-cube, MESMA CTF
//pré-integrada (Engel), MESMO shading por gradiente, MESMO empty-space skipping
//— mais o corte por lasso. World NOVO de propósito: o ESS fica intacto pro A/B.
//
//O que o LASSO acrescenta:
//  - binding 6: array<Lasso>. Cada lasso é a matriz clipFromLocal (= proj*view
//    *model da câmera CONGELADA no desenho), o AABB do polígono em NDC (early-
//    out), a fatia [first,count) no array de vértices e a operação.
//  - binding 7: array<vec2f> com os vértices em NDC de TODOS os lassos, em
//    sequência — fatiado por first/count. Um buffer só evita array de arrays.
//  - params ganha lassoCount (ocupa o padding que sobrava depois de spacing).
//
//No laço: cada amostra projeta pela matriz do lasso, divide por w e faz
//ponto-em-polígono por WINDING NUMBER. Dentro de um "remove-inside" → a amostra
//não contribui. Com perspectiva isso é uma PIRÂMIDE infinita com ápice no olho,
//não um prisma — que é justamente o que o usuário viu quando desenhou.
//
//Bind groups: iguais ao ESS nos grupos 0/1 e nos bindings 0-5 do grupo 2; o
//grupo 2 ganha 6 e 7. Só aceita MeshType.Static (o proxy-cube).
import { bakePreIntegrationTable, PREINT_TABLE_SIZE, type CtfPoint } from "../ctf";
import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh } from "../mesh";
import { MAX_LASSOS, MAX_LASSO_VERTICES } from "./lasso";

const DEFAULT_STEP_SIZE = 1 / 256;

//struct Lasso no shader: mat4x4f (64B) + 2 vec2f (16B) + 4 u32 (16B) = 96B.
//Múltiplo de 16, então serve de stride do array<Lasso> sem padding extra.
const LASSO_STRIDE_FLOATS = 24;

/** Um lasso pronto pra GPU — a behaviour monta, o material só escreve. */
export interface GpuLasso {
    /**
     * proj * view * model da câmera CONGELADA no instante do desenho, 16 floats
     * column-major (layout da wgpu-matrix, que é o mesmo do WGSL). Leva o ponto
     * do espaço LOCAL do volume ([-0.5,0.5]³) direto pro clip daquela câmera.
     */
    clipFromLocal: Float32Array;
    /** Vértices do polígono em NDC, x,y intercalados. */
    points: Float32Array;
    /** 0 = remove-inside, 1 = keep-inside (ver LASSO_OP_* no shader). */
    op: number;
}

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
    lassoCount: f32,   //quantos lassos ATIVOS (offset 44: o padding do vec3f)
    //---
    numChunks: vec3f,  //nº de chunks por eixo (f32 → u32 no shader; offset 48)
};
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var samp: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;
@group(2) @binding(3) var preint: texture_2d<f32>; //tabela pré-integrada T[sf][sb]
@group(2) @binding(4) var gradient: texture_3d<f32>; //o gradiente pré-calculado
@group(2) @binding(5) var<storage, read> occupied: array<u32>; //skip-map: 1=processa, 0=pula

//---- LASSO ----
const LASSO_OP_REMOVE: u32 = 0u; //some o que está DENTRO (vários = união)
const LASSO_OP_KEEP: u32 = 1u;   //só sobra o que está dentro (vários = interseção)

struct Lasso {
    //Espaço LOCAL do volume ([-0.5,0.5]³) → clip da câmera congelada no desenho.
    //Guardar a matriz (e não uma direção) é o que faz o corte casar EXATAMENTE
    //com o traço na tela: com perspectiva o sólido é uma pirâmide, não um prisma.
    //Como ela inclui a model, o corte fica colado no VOLUME — girar o volume
    //leva o corte junto, que é a semântica de "esculpir a peça".
    clipFromLocal: mat4x4f,
    ndcMin: vec2f,   //AABB do polígono: early-out antes do laço de arestas
    ndcMax: vec2f,
    first: u32,      //fatia deste lasso em lassoPoints
    count: u32,
    op: u32,
    _pad: u32,
};
@group(2) @binding(6) var<storage, read> lassos: array<Lasso>;
@group(2) @binding(7) var<storage, read> lassoPoints: array<vec2f>; //NDC, todos os lassos em sequência

const REFERENCE_SLICE_COUNT: f32 = 128.0;
const MAX_STEPS: i32 = 512;
//Nudge pra o salto de skip pousar DENTRO do próximo chunk (senão pode reler o
//mesmo e travar). Em unidades de t (rd é normalizado no espaço local, caixa=1).
const SKIP_EPS: f32 = 1e-4;

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

//Sinal da área do triângulo (a,b,p): >0 se p está à ESQUERDA da reta a→b.
fn isLeft(a: vec2f, b: vec2f, p: vec2f) -> f32 {
    return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

//Ponto-em-polígono pelo WINDING NUMBER, e não pelo par/ímpar: lasso à mão livre
//se auto-intersecta com frequência, e o winding é o que casa com a intuição de
//"tudo que eu cerquei" (par/ímpar abriria buracos nos laços cruzados).
fn insideLasso(li: u32, ndc: vec2f) -> bool {
    let ndcMin = lassos[li].ndcMin;
    let ndcMax = lassos[li].ndcMax;
    //A maioria das amostras de um raio cai fora: dois compares poupam o laço.
    if (any(ndc < ndcMin) || any(ndc > ndcMax)) {
        return false;
    }
    let first = lassos[li].first;
    let n = lassos[li].count;
    var wind = 0;
    for (var k = 0u; k < n; k = k + 1u) {
        let a = lassoPoints[first + k];
        //aresta de fechamento implícita: o último vértice liga no primeiro
        var nextK = k + 1u;
        if (nextK == n) {
            nextK = 0u;
        }
        let b = lassoPoints[first + nextK];
        //cruzamentos ascendentes contam +1, descendentes -1; a regra do <= num
        //lado e > no outro faz cada vértice contar UMA vez (sem dupla contagem
        //quando o raio horizontal passa exatamente por um vértice).
        if (a.y <= ndc.y) {
            if (b.y > ndc.y && isLeft(a, b, ndc) > 0.0) {
                wind = wind + 1;
            }
        } else {
            if (b.y <= ndc.y && isLeft(a, b, ndc) < 0.0) {
                wind = wind - 1;
            }
        }
    }
    return wind != 0;
}

//A amostra em pLocal SOBREVIVE aos lassos ativos?
fn lassoVisible(pLocal: vec3f) -> bool {
    let n = u32(params.lassoCount);
    if (n == 0u) {
        return true; //caso comum: nem entra no laço
    }
    var keepTotal = 0u;
    var keepHit = 0u;
    for (var i = 0u; i < n; i = i + 1u) {
        let clip = lassos[i].clipFromLocal * vec4f(pLocal, 1.0);
        var inside = false;
        //w<=0 é o que está ATRÁS do olho congelado: projeta espelhado no NDC,
        //então acertaria o polígono do lado errado. Nunca conta como dentro.
        if (clip.w > 0.0) {
            inside = insideLasso(i, clip.xy / clip.w);
        }
        if (lassos[i].op == LASSO_OP_REMOVE) {
            if (inside) {
                return false; //união: um "remove" que acerta já decide
            }
        } else {
            keepTotal = keepTotal + 1u;
            if (inside) {
                keepHit = keepHit + 1u;
            }
        }
    }
    //vários "keep-inside" = INTERSEÇÃO (cada um recorta mais, como um crop
    //encadeado). Sem nenhum keep, não há recorte a satisfazer.
    return keepTotal == 0u || keepHit == keepTotal;
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

        //LASSO: testa o MEIO do segmento [t, t+step], não uma das pontas. O par
        //(sf,sb) endereça a tabela pré-integrada de um SEGMENTO inteiro; cortar
        //só uma ponta indexaria T[sf][sb] com um par que não existe mais e
        //pintaria uma faixa de cor errada na borda do corte.
        if (!lassoVisible(camLocal + rd * (t + step * 0.5))) {
            t = t + step;
            continue;
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
                    //os lassos (registros) e os vértices deles, também read-only
                    { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
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
    //os lassos: dois storage buffers de tamanho FIXO (MAX_*), reescritos
    //inteiros a cada mudança da pilha. Recriar buffer invalidaria o bind group.
    private readonly lassoBuffer: GPUBuffer;
    private readonly lassoPointsBuffer: GPUBuffer;
    //staging na CPU, reaproveitado: a pilha muda por AÇÃO do usuário (raro),
    //mas alocar 2 arrays por mudança é lixo à toa.
    private readonly lassoStaging = new ArrayBuffer(MAX_LASSOS * LASSO_STRIDE_FLOATS * 4);
    private readonly lassoStagingF32 = new Float32Array(this.lassoStaging);
    private readonly lassoStagingU32 = new Uint32Array(this.lassoStaging);
    private readonly lassoPointsStaging = new Float32Array(MAX_LASSO_VERTICES * 2);
    private lassoCount = 0;
    private readonly bindGroup: GPUBindGroup;
    private ctfMin = 0;
    private ctfMax = 1;
    private alphaScale: number;
    private readonly stepSize: number;
    private useGradient: number;
    private gradientType: number;
    private useSkip: number;
    private readonly spacing: [number, number, number];
    private readonly numChunksX: number;
    private readonly numChunksY: number;
    private readonly numChunksZ: number;
    private readonly chunkSizeVoxels: number;

    /**
     * O material só AMOSTRA volumeTexture e gradientTexture; a posse (destroy) é
     * de quem as criou — o RaycastESSWorld. O skip-map (occupiedBuffer) é do
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
        this.lassoBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial lassos",
            size: MAX_LASSOS * LASSO_STRIDE_FLOATS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.lassoPointsBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial lasso vertices",
            size: MAX_LASSO_VERTICES * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        //default seguro: tudo ocupado (processa tudo) até o world/behaviour
        //mandarem o skip-map de verdade — assim nada é pulado por engano.
        this.setSkipMap(new Uint32Array(chunkGrid.totalChunks).fill(1));
        this.setCtf(ctfPoints); //bakeia a tabela + escreve os params

        this.bindGroup = device.createBindGroup({
            label: "VolumeRaycastLassoMaterial instance",
            layout: VolumeRaycastLassoMaterial.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: VolumeRaycastLassoMaterial.getSampler(device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: this.preintTexture.createView() },
                { binding: 4, resource: this.gradientTexture.createView({ dimension: "3d" }) },
                { binding: 5, resource: { buffer: this.occupiedBuffer } },
                { binding: 6, resource: { buffer: this.lassoBuffer } },
                { binding: 7, resource: { buffer: this.lassoPointsBuffer } },
            ],
        });
    }

    /**
     * Reescreve a pilha INTEIRA de lassos ativos (a lista já cortada no cursor
     * de undo pela behaviour). Chamada por AÇÃO do usuário, não por frame.
     *
     * Os dois buffers são de tamanho fixo: o que passar de MAX_LASSOS /
     * MAX_LASSO_VERTICES é descartado com aviso, em vez de estourar a escrita.
     */
    setLassos(list: readonly GpuLasso[]): void {
        let count = 0;
        let vertexCursor = 0;
        for (const lasso of list) {
            const numPoints = lasso.points.length / 2;
            if (count >= MAX_LASSOS || vertexCursor + numPoints > MAX_LASSO_VERTICES) {
                console.warn(
                    `VolumeRaycastLassoMaterial: pilha de lassos estourou o teto ` +
                    `(${MAX_LASSOS} lassos / ${MAX_LASSO_VERTICES} vértices) — o excedente foi ignorado.`,
                );
                break;
            }
            //polígono precisa de 3 vértices pra ter interior
            if (numPoints < 3) {
                continue;
            }
            const base = count * LASSO_STRIDE_FLOATS;
            this.lassoStagingF32.set(lasso.clipFromLocal, base);
            //AABB do polígono, calculado aqui pra ninguém precisar mandá-lo junto
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < lasso.points.length; i = i + 2) {
                minX = Math.min(minX, lasso.points[i]);
                maxX = Math.max(maxX, lasso.points[i]);
                minY = Math.min(minY, lasso.points[i + 1]);
                maxY = Math.max(maxY, lasso.points[i + 1]);
            }
            this.lassoStagingF32[base + 16] = minX;
            this.lassoStagingF32[base + 17] = minY;
            this.lassoStagingF32[base + 18] = maxX;
            this.lassoStagingF32[base + 19] = maxY;
            //os u32 do struct compartilham o mesmo ArrayBuffer dos floats
            this.lassoStagingU32[base + 20] = vertexCursor;
            this.lassoStagingU32[base + 21] = numPoints;
            this.lassoStagingU32[base + 22] = lasso.op;
            this.lassoStagingU32[base + 23] = 0;
            this.lassoPointsStaging.set(lasso.points, vertexCursor * 2);
            vertexCursor = vertexCursor + numPoints;
            count = count + 1;
        }
        this.lassoCount = count;
        //escreve só o prefixo usado: o resto do buffer é lixo que o shader nunca
        //lê (o laço vai até params.lassoCount).
        if (count > 0) {
            this.device.queue.writeBuffer(
                this.lassoBuffer, 0, this.lassoStaging, 0, count * LASSO_STRIDE_FLOATS * 4,
            );
            this.device.queue.writeBuffer(
                this.lassoPointsBuffer, 0, this.lassoPointsStaging.buffer, 0, vertexCursor * 2 * 4,
            );
        }
        this.writeParams();
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

    private writeParams(): void {
        //struct Params (uniform std140-ish): spacing:vec3f no byte 32 (índice 8),
        //numChunks:vec3f no byte 48 (índice 12). O índice 11 (byte 44) era
        //padding do vec3f e agora carrega o lassoCount — um f32 depois de um
        //vec3f encaixa nesse buraco sem mudar o tamanho da struct. Índice 15
        //continua padding.
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([
                this.ctfMin, this.ctfMax, this.alphaScale, this.stepSize,
                this.useGradient, this.gradientType, this.useSkip, this.chunkSizeVoxels,
                this.spacing[0], this.spacing[1], this.spacing[2], this.lassoCount,
                this.numChunksX, this.numChunksY, this.numChunksZ, 0,
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
        this.lassoBuffer.destroy();
        this.lassoPointsBuffer.destroy();
    }
}
