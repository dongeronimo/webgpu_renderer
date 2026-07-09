//Material do RAYCASTER de volume (single-pass, proxy-cube).
//
//Diferente do VR por fatias (que desenha N quads translúcidos e deixa o
//blend do hardware compor), aqui UM fragment por pixel marcha o raio dentro
//da caixa e compõe o volume inteiro em software (front-to-back). O proxy é
//o unitary_cube.glb ([-0.5,0.5]³ em local); renderamos as BACK-FACES
//(cullMode "front") pra ter cobertura mesmo com a câmera dentro da caixa, e
//reconstruímos a entrada/saída do raio por interseção analítica raio-caixa.
//
//Reaproveita EXATAMENTE o sistema de CTF do textureStackVolumeRenderCT: a
//tabela 2D pré-integrada do Engel (bakePreIntegrationTable), amostrada pelo
//par (sf, sb) = HU na frente e no fundo de um passo. Ainda SEM gradiente e
//SEM empty-space-skipping — o objetivo desta etapa é só o VR na tela.
//
//Bind groups (grupos 0 e 1 são do MeshRenderPass, lidos no fragment porque
//o layout dele agora é VERTEX|FRAGMENT):
//  grupo 0 (frame)    — view + proj; a câmera-mundo sai da view.
//  grupo 1 (objeto)   — array de model matrices; a caixa usa a sua (invertida
//                       leva o raio pro espaço local).
//  grupo 2 (material) — params (domínio da CTF + alpha + passo), sampler,
//                       volume 3D (HU r16float) e a tabela pré-integrada 2D.
//
//Só aceita MeshType.Static: o proxy é uma mesh comum (o cubo do glb).
import { bakePreIntegrationTable, PREINT_TABLE_SIZE, type CtfPoint } from "../ctf";
import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh } from "../mesh";

//Passo local de amostragem: 1/256 dá ~256 amostras num raio axial e ~443 na
//diagonal da caixa (√3). MAX_STEPS cobre a diagonal com folga. Qualidade
//sobre velocidade — o usuário pode adensar depois (a densidade não muda: a
//correção de opacidade por passo compensa, ver o fragment).
const DEFAULT_STEP_SIZE = 1 / 256;

const RAYCAST_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;

struct Params {
    ctfMin: f32,      //HU do primeiro ponto da CTF (início do domínio)
    ctfMax: f32,      //HU do último ponto (fim do domínio)
    alphaScale: f32,  //dilui a opacidade da CTF por passo (knob da UI)
    stepSize: f32,    //passo local ao longo do raio (espaço da caixa)
    useGradient: f32, //>0.5 liga o shading por gradiente on-the-fly (toggle da UI)
};
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var samp: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;
@group(2) @binding(3) var preint: texture_2d<f32>; //tabela pré-integrada T[sf][sb]

//Nº de fatias de REFERÊNCIA pro qual os alphas da CTF são calibrados — o
//mesmo REFERENCE_SLICE_COUNT do material de slices e da pré-integração
//(ctf.ts). A opacidade de um passo de tamanho h vira 1-(1-a)^(h/(1/REF)).
const REFERENCE_SLICE_COUNT: f32 = 128.0;
//Teto do laço de marcha (a diagonal da caixa a 1/256 dá ~443 passos).
const MAX_STEPS: i32 = 512;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) localPos: vec3f, //posição na caixa [-0.5,0.5]³ (interpolada)
    //flat: entrega o índice da instância pro fragment achar a model dele
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

//Inversa da parte linear 3x3 (colunas a,b,c) via adjugada/determinante —
//WGSL não tem inverse embutida. A caixa tem escala não-uniforme (proporções
//físicas do exame), então precisa da inversa de verdade, não da transposta.
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
    //Câmera-mundo a partir da view (view = inverse(cameraWorld)): pra uma
    //view rígida, cameraWorld = -Rᵀ·t, com R = parte 3x3 da view e t a
    //translação. (Assume câmera sem escala — como o material de slices.)
    let R = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
    let camWorld = -(transpose(R) * frame.view[3].xyz);
    //Câmera no espaço LOCAL da caixa: local = invLin · (mundo - t).
    let invLin = inverse3(mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz));
    let camLocal = invLin * (camWorld - model[3].xyz);
    //O raio parte da câmera e passa pelo ponto de superfície deste fragment.
    let rd = normalize(in.localPos - camLocal);

    //Interseção raio-caixa (slab) contra [-0.5,0.5]³. Divisão por zero em rd
    //vira ±inf e o min/max resolve certo (comportamento IEEE).
    let invD = 1.0 / rd;
    let t0 = (vec3f(-0.5) - camLocal) * invD;
    let t1 = (vec3f(0.5) - camLocal) * invD;
    let tsmall = min(t0, t1);
    let tbig = max(t0, t1);
    var tNear = max(max(tsmall.x, tsmall.y), tsmall.z);
    let tFar = min(min(tbig.x, tbig.y), tbig.z);
    tNear = max(tNear, 0.0); //câmera dentro da caixa: começa em t=0
    if (tFar <= tNear) {
        discard;
    }

    let step = params.stepSize;
    //correção de opacidade: um passo h equivale a h/(1/REF) fatias de
    //referência, logo alpha = 1-(1-aRef)^(h·REF). Mesma matemática do slice.
    let opacityExponent = step * REFERENCE_SLICE_COUNT;
    let range = max(params.ctfMax - params.ctfMin, 1e-6);

    //Pré-cálculos do shading on-the-fly (só usados se o gradiente estiver on):
    //espaçamento de 1 voxel em uvw por eixo (da resolução REAL do volume) e a
    //luz fixa. textureDimensions é uniforme — fica fora do laço.
    let voxel = 1.0 / vec3f(textureDimensions(volume));
    let lightPos = vec3f(5.0, 5.0, 5.0);
    //transpose(inverse(A)) = matriz de normais: leva o gradiente do espaço
    //local pro mundo respeitando a escala não-uniforme da caixa.
    let normalMatrix = transpose(invLin);

    //Composição FRONT-TO-BACK (marchamos da entrada pra saída = perto→longe).
    //acc guarda cor JÁ pré-multiplicada pela cobertura + o alpha acumulado.
    var acc = vec4f(0.0);
    var t = tNear;
    for (var i = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= tFar) {
            break;
        }
        let pLocal = camLocal + rd * t;
        let uvw = pLocal + vec3f(0.5); //caixa [-0.5,0.5]³ → [0,1]³ de textura
        //frente (sf, aqui) e fundo (sb, um passo adiante no raio)
        let sf = textureSampleLevel(volume, samp, uvw, 0.0).r;
        let sb = textureSampleLevel(volume, samp, uvw + rd * step, 0.0).r;
        //sf/sb normalizados endereçam a tabela 2D; clamp-to-edge estende as
        //pontas do domínio. x = sf (frente), y = sb (fundo).
        let uf = (sf - params.ctfMin) / range;
        let ub = (sb - params.ctfMin) / range;
        let c = textureSampleLevel(preint, samp, vec2f(uf, ub), 0.0);

        //SHADING opcional: o gradiente sai de 6 amostras EXTRAS do volume
        //(diferenças centrais) A CADA passo — caro de propósito. É o custo
        //real que o toggle da UI liga/desliga; sem gradiente, cor chapada.
        var rgb = c.rgb;
        if (params.useGradient > 0.5) {
            let gx = textureSampleLevel(volume, samp, uvw + vec3f(voxel.x, 0.0, 0.0), 0.0).r
                   - textureSampleLevel(volume, samp, uvw - vec3f(voxel.x, 0.0, 0.0), 0.0).r;
            let gy = textureSampleLevel(volume, samp, uvw + vec3f(0.0, voxel.y, 0.0), 0.0).r
                   - textureSampleLevel(volume, samp, uvw - vec3f(0.0, voxel.y, 0.0), 0.0).r;
            let gz = textureSampleLevel(volume, samp, uvw + vec3f(0.0, 0.0, voxel.z), 0.0).r
                   - textureSampleLevel(volume, samp, uvw - vec3f(0.0, 0.0, voxel.z), 0.0).r;
            let gLocal = vec3f(gx, gy, gz);
            //normalize explodiria em região homogênea (gradiente ~0): só
            //sombreia onde há borda de verdade; senão fica a cor chapada.
            if (length(gLocal) > 1e-4) {
                //normal aponta CONTRA o gradiente (do denso pro menos denso =
                //pra FORA da estrutura), levada ao mundo pela matriz de normais
                let N = normalize(normalMatrix * (-gLocal));
                let pWorld = (model * vec4f(pLocal, 1.0)).xyz;
                let L = normalize(lightPos - pWorld);
                let V = normalize(camWorld - pWorld);
                let H = normalize(L + V);
                let diffuse = max(dot(N, L), 0.0);
                let specular = pow(max(dot(N, H), 0.0), 32.0);
                let ambient = 0.2; //pro lado oposto à luz não ir a preto absoluto
                rgb = c.rgb * (ambient + (1.0 - ambient) * diffuse) + vec3f(0.3 * specular);
            }
        }

        let aRef = clamp(c.a * params.alphaScale, 0.0, 1.0);
        let alpha = 1.0 - pow(1.0 - aRef, opacityExponent);
        let w = (1.0 - acc.a) * alpha; //peso deste passo na composição
        acc = vec4f(acc.rgb + w * rgb, acc.a + w);
        if (acc.a >= 0.995) {
            break; //early ray termination: opaco o bastante, o resto não aparece
        }
        t = t + step;
    }
    return acc; //pré-multiplicado — o pipeline usa blend premultiplied
}
`;

export class VolumeRaycastMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "VolumeRaycastMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType: "float", viewDimension: "3d" },
                    },
                    {
                        binding: 3,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType: "float", viewDimension: "2d" },
                    },
                ],
            });
        }
        return this.materialLayout;
    }

    //Linear + clamp: serve ao volume (r16float é filterable) E à tabela
    //pré-integrada — o clamp é o que estende as pontas do domínio da CTF.
    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "VolumeRaycastMaterial sampler",
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
                label: "VolumeRaycastMaterial shader",
                code: RAYCAST_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "VolumeRaycastMaterial (Static)",
            layout: device.createPipelineLayout({
                label: "VolumeRaycastMaterial pipeline layout",
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
                        //saída pré-multiplicada compondo sobre o que o pass
                        //já limpou (o fundo do MeshRenderPass)
                        blend: {
                            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            //cullMode "front" = desenha as BACK-FACES: garante um fragment por
            //pixel da silhueta mesmo com a câmera dentro da caixa.
            primitive: { topology: "triangle-list", cullMode: "front" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: false, //objeto único; não precisa escrever depth
                depthCompare: "less-equal",
            },
        });
    }

    //---- nível da INSTÂNCIA: volume + CTF + parâmetros desta instância ----
    private readonly device: GPUDevice;
    private readonly volumeTexture: GPUTexture;
    private readonly preintTexture: GPUTexture;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    //domínio corrente da CTF — guardado pra os setters reescreverem o
    //uniform inteiro sem rebakear a tabela
    private ctfMin = 0;
    private ctfMax = 1;
    private alphaScale: number;
    private readonly stepSize: number;
    //0 ou 1 (o shader compara > 0.5) — liga o shading por gradiente on-the-fly
    private useGradient: number;

    /** O material assume a posse da textura 3D (destroy() a libera junto). */
    constructor(
        device: GPUDevice,
        volumeTexture: GPUTexture,
        /** Pontos de controle da CTF, ordenados por HU (ver ctf.ts). */
        ctfPoints: readonly CtfPoint[],
        alphaScale = 0.3,
        gradientShading = false,
        stepSize = DEFAULT_STEP_SIZE,
    ) {
        super();
        this.device = device;
        this.volumeTexture = volumeTexture;
        this.alphaScale = alphaScale;
        this.useGradient = gradientShading ? 1 : 0;
        this.stepSize = stepSize;

        this.paramsBuffer = device.createBuffer({
            label: "VolumeRaycastMaterial params",
            size: 32, //5 floats; uniform arredonda o tamanho da struct pra 16
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.preintTexture = device.createTexture({
            label: "VolumeRaycastMaterial preintegration table",
            size: [PREINT_TABLE_SIZE, PREINT_TABLE_SIZE, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.setCtf(ctfPoints); //bakeia a tabela + escreve os params

        this.bindGroup = device.createBindGroup({
            label: "VolumeRaycastMaterial instance",
            layout: VolumeRaycastMaterial.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: VolumeRaycastMaterial.getSampler(device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: this.preintTexture.createView() },
            ],
        });
    }

    /**
     * Troca a curva em runtime: rebakeia a tabela 2D pré-integrada e atualiza
     * o domínio no uniform. É o que a VolumeRaycastBehaviour chama quando o
     * state ctf do redux muda — o MESMO caminho do material de slices.
     */
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

    /** Ajusta a diluição de opacidade por passo em runtime (knob da UI). */
    setAlphaScale(alphaScale: number): void {
        this.alphaScale = alphaScale;
        this.writeParams();
    }

    /**
     * Liga/desliga o shading por gradiente on-the-fly (toggle da UI). Ligado,
     * o shader faz 6 amostras extras do volume por passo — deliberadamente
     * caro, pra medir o custo real do gradiente calculado na marcha.
     */
    setGradientShading(enabled: boolean): void {
        this.useGradient = enabled ? 1 : 0;
        this.writeParams();
    }

    private writeParams(): void {
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([this.ctfMin, this.ctfMax, this.alphaScale, this.stepSize, this.useGradient]),
        );
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Static) {
            throw new Error(
                `VolumeRaycastMaterial só desenha MeshType.Static (o proxy-cube), recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!VolumeRaycastMaterial.pipeline) {
            VolumeRaycastMaterial.pipeline = VolumeRaycastMaterial.createPipeline(ctx);
        }
        return VolumeRaycastMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera a textura 3D, a tabela pré-integrada e o buffer de params. */
    override destroy(): void {
        this.volumeTexture.destroy();
        this.preintTexture.destroy();
        this.paramsBuffer.destroy();
    }
}
