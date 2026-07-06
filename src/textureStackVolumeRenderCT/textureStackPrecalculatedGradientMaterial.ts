//Material das fatias do VR clássico. É aqui que mora quase todo o volume
//rendering desta técnica:
//  - o TIPO carrega o pipeline com o BLEND (src-alpha sobre o que já foi
//    desenhado), depthWriteEnabled: false (fatia testa contra opacos mas
//    não escreve) e cullMode "none" (o winding do polígono flipa conforme
//    o lado de onde a câmera olha);
//  - a INSTÂNCIA carrega a textura 3D do volume (HU em r16float), o
//    sampler linear, a LUT da CTF e os parâmetros (domínio da LUT + alpha).
//
//A diferença dessa versão para o textureStackTransparentMaterial é que essa
//versão usa um gradiente rgba8 pré calculado e faz shading phong.
//
//O fragment aplica a COLOR TRANSFER FUNCTION: o HU sampleado vira índice
//numa LUT 512×1 rgba8 rasterizada na CPU a partir dos pontos de controle
//(CtfPoint — ver ctf.ts, que explica domínio e clamp). setCtf() troca a
//curva em runtime: reescreve a LUT e o domínio, sem tocar em pipeline —
//é o que a SetCtfBehaviour chama quando o state ctf do redux muda.
//
//Dois knobs de densidade, independentes de propósito:
//  - alphaScale: quanto UMA fatia (na pilha de REFERÊNCIA) contribui;
//  - setSliceCount: só CORRIGE a opacidade pro slab mais fino/grosso
//    (1-(1-a)^(N_ref/N)) — mudar a contagem não muda o acúmulo total.
//
//Só aceita MeshType.VolumeSlice: o vertex layout (pos+uvw, 24 bytes) é o
//da SliceMesh e não bate com o das meshes comuns.
import { bakeCtfLut, CTF_LUT_WIDTH, type CtfPoint } from "../ctf";
import { Material, type PipelineContext } from "../material";
import { MeshType } from "../mesh";
import { SliceMesh } from "../textureStackVolumeRender/sliceMesh";

/**
 * Contagem de fatias pra qual os alphas da CTF (e o alphaScale) são
 * calibrados. Com outra contagem N, o shader corrige a opacidade por slab
 * pra 1-(1-a)^(REF/N) — o acúmulo total não depende de N (setSliceCount).
 */
export const REFERENCE_SLICE_COUNT = 128;

const SLICES_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,//novo
};
struct MaterialParams {
    ctfMin: f32,     //HU do primeiro ponto da CTF (início da LUT)
    ctfMax: f32,     //HU do último ponto (fim da LUT)
    alphaScale: f32, //dilui a opacidade da CTF pra UMA fatia da pilha
    opacityExponent: f32, //correção de opacidade: N_referência / N_fatias
};
//Slot de instância do bufferzão do pass (contrato do
//TransparentSlicesRenderPass): a model E a normal matrix — matriz não
//atravessa @location, então o fragment busca a normal matrix AQUI, com
//o índice da instância chegando flat do vertex.
struct ObjectData {
    model: mat4x4f,
    //transpose(inverse(model)): leva normais/gradientes do espaço local
    //pro mundo respeitando a escala não-uniforme do nó-pilha
    normalMatrix: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;
@group(2) @binding(0) var<uniform> material: MaterialParams;
@group(2) @binding(1) var volSampler: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;
@group(2) @binding(3) var ctf: texture_2d<f32>; //LUT 512×1 da transfer function
@group(2) @binding(4) var gradient: texture_3d<f32>; //novo

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) uvw: vec3f,
    @location(1) worldPos: vec3f,
    //flat: mesmo valor nos 3 vértices, nenhuma interpolação — é só o
    //jeito de entregar o índice pro fragment indexar objects[]
    @location(2) @interpolate(flat) instance: u32,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) uvw: vec3f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    let world = objects[instance].model * vec4f(position, 1.0);
    out.position = frame.proj * frame.view * world;
    out.uvw = uvw;
    out.worldPos = world.xyz;
    out.instance = instance;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let lightPos = vec3f(5.0, 5.0, 5.0); //hardcoded por hora
    let hu = textureSample(volume, volSampler, in.uvw).r;
    //HU normalizado indexa a LUT; fora do domínio o clamp-to-edge do
    //sampler estende as pontas da curva (ver ctf.ts)
    let u = (hu - material.ctfMin) / (material.ctfMax - material.ctfMin);
    let c = textureSample(ctf, volSampler, vec2f(u, 0.5));
    //a textura guarda dir*0.5+0.5 (rgba8 não tem sinal) — decodifica de
    //volta pra [-1,1]; o .a é a magnitude normalizada (ver gradientCompute)
    let dHU = textureSample(gradient, volSampler, in.uvw);
    let g = dHU.xyz * 2.0 - 1.0;
    //blinn-phong, SÓ onde há gradiente: em região homogênea (a≈0) a
    //direção decodificada é ruído perto de zero e normalize explodiria —
    //lá fica a cor da CTF pura (equivale a só ambiente)
    var rgb = c.rgb;
    if (dHU.a > 0.01) {
        //normal aponta CONTRA o gradiente: do denso pro menos denso,
        //ou seja pra FORA da estrutura (osso → ar)
        let N = normalize((objects[in.instance].normalMatrix * vec4f(-g, 0.0)).xyz);
        let L = normalize(lightPos - in.worldPos);
        let V = normalize(frame.cameraPos.xyz - in.worldPos);
        let H = normalize(L + V);
        let diffuse = max(dot(N, L), 0.0);
        //especular pesado pela magnitude: brilho só em borda de verdade,
        //não em ruído de tecido mole
        let specular = pow(max(dot(N, H), 0.0), 32.0) * dHU.a;
        let ambient = 0.2; //pro lado oposto à luz não ir a preto absoluto
        rgb = c.rgb * (ambient + (1.0 - ambient) * diffuse) + vec3f(0.3 * specular);
    }
    //CORREÇÃO DE OPACIDADE: o alpha da CTF (× alphaScale) é definido pra
    //pilha de REFERÊNCIA; com N fatias cada slab fica N_ref/N vezes mais
    //fino, e a opacidade equivalente do slab fino é 1-(1-a)^(N_ref/N).
    //Sem isto o slider de fatias também seria um slider de densidade —
    //com isto ele muda só a qualidade do sampling, o acúmulo é invariante.
    let aRef = c.a * material.alphaScale;
    let alpha = 1.0 - pow(1.0 - aRef, material.opacityExponent);
    return vec4f(rgb, alpha);
}
`;

export class TextureStackPrecalculatedMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "TextureStackPrecalculatedMaterial material",
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
                    { //novo
                        binding: 4,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType:"float", viewDimension: "3d"},
                    } 
                ],
            });
        }
        return this.materialLayout;
    }

    //Linear nos três eixos (r16float é filterable, r32float não seria!) e
    //clamp: uvw fora de [0,1] repete a borda em vez de enrolar o volume.
    //O MESMO sampler serve a LUT da CTF: o clamp é o que estende as pontas
    //da curva pra HU fora do domínio [ctfMin, ctfMax].
    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "TextureStackTransparentMaterial sampler",
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
                label: "TextureStackPrecalculatedMaterial shader",
                code: SLICES_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "TextureStackPrecalculatedMaterial (VolumeSlice)",
            layout: device.createPipelineLayout({
                label: "TextureStackPrecalculatedMaterial pipeline layout",
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [SliceMesh.vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: ctx.colorFormat,
                        //o coração da técnica: composição back-to-front no
                        //hardware de blend, fatia sobre fatia
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            //cullMode none: o mesmo polígono é visto dos dois lados quando
            //a câmera orbita
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: false, //fatia não oclui fatia
                depthCompare: "less-equal", //mas respeita opacos, se houver
            },
        });
    }

    //---- nível da INSTÂNCIA: volume + CTF + parâmetros desta instância ----
    private readonly device: GPUDevice;
    private readonly volumeTexture: GPUTexture;
    private readonly lutTexture: GPUTexture;
    private readonly gradientTexture: GPUTexture;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    //domínio corrente da LUT — guardados pra os setters reescreverem o
    //uniform inteiro sem rebakear a curva
    private ctfMin = 0;
    private ctfMax = 1;
    private alphaScale: number;
    private sliceCount = REFERENCE_SLICE_COUNT;

    /** O material assume a posse da textura 3D (destroy() a libera junto). */
    constructor(
        device: GPUDevice,
        volumeTexture: GPUTexture,
        gradientTexture: GPUTexture,
        /** Pontos de controle da CTF, ordenados por HU (ver ctf.ts). */
        ctfPoints: readonly CtfPoint[],
        //densidade por fatia DE REFERÊNCIA — knob separado do sliceCount
        //(que só corrige, não adensa) e da CTF; candidato a slider da UI
        alphaScale = 0.3,
    ) {
        super();
        this.device = device;
        this.volumeTexture = volumeTexture;
        this.gradientTexture = gradientTexture;
        this.alphaScale = alphaScale;

        this.paramsBuffer = device.createBuffer({
            label: "TextureStackTransparentMaterial params",
            size: 16, //4 floats, o mínimo alinhado de um uniform
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.lutTexture = device.createTexture({
            label: "TextureStackTransparentMaterial ctf lut",
            size: [CTF_LUT_WIDTH, 1, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.setCtf(ctfPoints);

        this.bindGroup = device.createBindGroup({
            label: "TextureStackTransparentMaterial instance",
            layout: TextureStackPrecalculatedMaterial.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: TextureStackPrecalculatedMaterial.getSampler(device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: this.lutTexture.createView() },
                { binding: 4, resource: this.gradientTexture.createView() },
            ],
        });
    }

    /**
     * Troca a curva em runtime: rasteriza os pontos na LUT e atualiza o
     * domínio no uniform. Barato (512 texels na CPU + um writeTexture) —
     * pode ser chamado a cada mudança do editor sem cerimônia.
     */
    setCtf(points: readonly CtfPoint[]): void {
        const baked = bakeCtfLut(points);
        this.ctfMin = baked.huMin;
        this.ctfMax = baked.huMax;
        this.device.queue.writeTexture(
            { texture: this.lutTexture },
            baked.data,
            { bytesPerRow: CTF_LUT_WIDTH * 4 },
            [CTF_LUT_WIDTH, 1, 1],
        );
        this.writeParams();
    }

    /** Ajusta a diluição por fatia em runtime (knob da UI). */
    setAlphaScale(alphaScale: number): void {
        this.alphaScale = alphaScale;
        this.writeParams();
    }

    /**
     * Informa quantas fatias a pilha tem AGORA, pra correção de opacidade
     * (ver o comentário no fragment). Chamar junto do setSliceCount do
     * generator — no mundo CT quem faz as duas chamadas é a
     * SetNumSlicesBehaviour.
     */
    setSliceCount(count: number): void {
        if (count === this.sliceCount || count <= 0) {
            return;
        }
        this.sliceCount = count;
        this.writeParams();
    }

    private writeParams(): void {
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([
                this.ctfMin,
                this.ctfMax,
                this.alphaScale,
                REFERENCE_SLICE_COUNT / this.sliceCount,
            ]),
        );
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.VolumeSlice) {
            throw new Error(
                `TextureStackTransparentMaterial só desenha MeshType.VolumeSlice, recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!TextureStackPrecalculatedMaterial.pipeline) {
            TextureStackPrecalculatedMaterial.pipeline =
                TextureStackPrecalculatedMaterial.createPipeline(ctx);
        }
        return TextureStackPrecalculatedMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera a textura 3D, a LUT e o buffer de parâmetros desta instância. */
    override destroy(): void {
        this.volumeTexture.destroy();
        this.lutTexture.destroy();
        this.paramsBuffer.destroy();
        this.gradientTexture.destroy();
    }
}
