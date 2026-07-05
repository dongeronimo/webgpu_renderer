//Material das fatias do VR clássico. É aqui que mora quase todo o volume
//rendering desta técnica:
//  - o TIPO carrega o pipeline com o BLEND (src-alpha sobre o que já foi
//    desenhado), depthWriteEnabled: false (fatia testa contra opacos mas
//    não escreve) e cullMode "none" (o winding do polígono flipa conforme
//    o lado de onde a câmera olha);
//  - a INSTÂNCIA carrega a textura 3D do volume (HU em r16float), o
//    sampler linear e os parâmetros de window/level.
//
//O fragment é a "transfer function" hardcoded desta primeira versão:
//window/level clássico de radiologia — mapeia a janela de HU
//[center - width/2, center + width/2] pra [0,1] — e usa o resultado como
//cinza E como opacidade (escalada por alphaScale, que dilui a contribuição
//de cada fatia na pilha). A CTF de verdade (LUT editável pela UI) troca só
//esse trecho no futuro.
//
//Só aceita MeshType.VolumeSlice: o vertex layout (pos+uvw, 24 bytes) é o
//da SliceMesh e não bate com o das meshes comuns.
import { Material, type PipelineContext } from "../material";
import { MeshType } from "../mesh";
import { SliceMesh } from "./sliceMesh";

const SLICES_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
struct MaterialParams {
    windowCenter: f32, //centro da janela de HU (level)
    windowWidth: f32,  //largura da janela de HU
    alphaScale: f32,   //opacidade máxima de UMA fatia
    _pad: f32,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;
@group(2) @binding(0) var<uniform> material: MaterialParams;
@group(2) @binding(1) var volSampler: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) uvw: vec3f,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) uvw: vec3f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    out.position = frame.proj * frame.view * models[instance] * vec4f(position, 1.0);
    out.uvw = uvw;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let hu = textureSample(volume, volSampler, in.uvw).r;
    //window/level: HU dentro da janela vira [0,1], fora satura
    let x = clamp((hu - material.windowCenter) / material.windowWidth + 0.5, 0.0, 1.0);
    //transfer function rudimentar: o mesmo x é cinza e opacidade — quem
    //está abaixo da janela some, quem está acima fica branco e denso
    let alpha = x * material.alphaScale;
    return vec4f(vec3f(x), alpha);
}
`;

export class TextureStackTransparentMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "TextureStackTransparentMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType: "float", viewDimension: "3d" },
                    },
                ],
            });
        }
        return this.materialLayout;
    }

    //Linear nos três eixos (r16float é filterable, r32float não seria!) e
    //clamp: uvw fora de [0,1] repete a borda em vez de enrolar o volume.
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
                label: "TextureStackTransparentMaterial shader",
                code: SLICES_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "TextureStackTransparentMaterial (VolumeSlice)",
            layout: device.createPipelineLayout({
                label: "TextureStackTransparentMaterial pipeline layout",
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

    //---- nível da INSTÂNCIA: volume + parâmetros desta instância ----
    private readonly device: GPUDevice;
    private readonly volumeTexture: GPUTexture;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;

    /** O material assume a posse da textura 3D (destroy() a libera junto). */
    constructor(
        device: GPUDevice,
        volumeTexture: GPUTexture,
        //defaults: janela de tecido mole clássica (W400 L40)
        windowCenter = 40,
        windowWidth = 400,
        alphaScale = 0.05,
    ) {
        super();
        this.device = device;
        this.volumeTexture = volumeTexture;

        this.paramsBuffer = device.createBuffer({
            label: "TextureStackTransparentMaterial params",
            size: 16, //4 floats, o mínimo alinhado de um uniform
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.setParams(windowCenter, windowWidth, alphaScale);

        this.bindGroup = device.createBindGroup({
            label: "TextureStackTransparentMaterial instance",
            layout: TextureStackTransparentMaterial.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: TextureStackTransparentMaterial.getSampler(device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
            ],
        });
    }

    /** Ajusta window/level e opacidade em runtime (futuro: chamado pela UI). */
    setParams(windowCenter: number, windowWidth: number, alphaScale: number): void {
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([windowCenter, windowWidth, alphaScale, 0]),
        );
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.VolumeSlice) {
            throw new Error(
                `TextureStackTransparentMaterial só desenha MeshType.VolumeSlice, recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!TextureStackTransparentMaterial.pipeline) {
            TextureStackTransparentMaterial.pipeline =
                TextureStackTransparentMaterial.createPipeline(ctx);
        }
        return TextureStackTransparentMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera a textura 3D e o buffer de parâmetros desta instância. */
    override destroy(): void {
        this.volumeTexture.destroy();
        this.paramsBuffer.destroy();
    }
}
