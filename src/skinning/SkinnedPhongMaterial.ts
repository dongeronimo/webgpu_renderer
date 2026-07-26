//SkinnedPhongMaterial: mesmo Blinn-Phong do PhongColorMaterial, mas o
//vértice é deformado por LINEAR BLEND SKINNING antes de iluminar. Só roda no
//SkinnedRenderPass — o grupo 1 dele é o pool de matrizes de osso (um bloco
//por objeto), não as model matrices do main pass.
//
//Segue o molde dos outros materiais (ver material.ts): o TIPO cacheia
//pipeline/layout em membros static; a INSTÂNCIA tem seu uniform + bind group.
//
//Luz DIRECIONAL de propósito: a `light0Pos` do frame é tratada como uma
//DIREÇÃO (não posição), sem atenuação por distância. Assim a iluminação
//independe da escala do modelo — xbot tem ~1.8 unidades de altura, e a
//atenuação linear do PhongColorMaterial (calibrada pra nave de ~60u)
//deixaria tudo estourado ou preto aqui.
import { Material, type PipelineContext } from "../material";
import { MeshType, SkinnedMesh } from "../mesh";

const SKINNED_PHONG_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
    light0Pos: vec4f, //aqui: DIREÇÃO da luz (tratada normalizada no fs)
};
struct MaterialParams {
    color: vec4f,
    ambient: vec3f,
    specular: f32, //expoente de brilho (shininess)
};
@group(0) @binding(0) var<uniform> frame: Frame;
//Pool PLANO de matrizes de skinning (pose = boneWorld · inverseBind; no bind
//pose vira identidade). Cada objeto ocupa exatamente o número de ossos do SEU
//esqueleto, um bloco atrás do outro; como os blocos têm tamanhos diferentes,
//quem diz onde começa o desta instância é boneOffsets[instance_index] — é o
//que permite draw INSTANCIADO (N cópias, N esqueletos, 1 draw call).
@group(1) @binding(0) var<storage, read> poses: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> boneOffsets: array<u32>;
@group(2) @binding(0) var<uniform> material: MaterialParams;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) worldNormal: vec3f,
    @location(1) worldPosition: vec3f,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    //Matriz de skinning combinada: média ponderada das poses das 4 juntas
    //que influenciam o vértice. Pesos vêm normalizados do arquivo (somam ~1).
    //Junta com peso 0 contribui zero, então o id de padding (0) é inofensivo.
    let base = boneOffsets[instance];
    let m =
        poses[base + joints.x] * weights.x +
        poses[base + joints.y] * weights.y +
        poses[base + joints.z] * weights.z +
        poses[base + joints.w] * weights.w;

    let worldPos = m * vec4f(position, 1.0);
    var out: VsOut;
    out.worldPosition = worldPos.xyz;
    //Aproximação padrão: transforma a normal pela própria matriz de skinning
    //(parte 3x3). Correto pra rotação/translação; distorce sob escala
    //não-uniforme por osso — que não é o caso aqui.
    out.worldNormal = (m * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let N = normalize(in.worldNormal);
    let L = normalize(frame.light0Pos.xyz); //luz direcional
    let NdotL = saturate(dot(N, L));

    //especular Blinn-Phong (half-vector), só onde a face vê a luz
    let V = normalize(frame.cameraPos.xyz - in.worldPosition);
    let H = normalize(L + V);
    let specular = select(0.0, pow(saturate(dot(N, H)), material.specular), NdotL > 0.0);

    let litColor = material.ambient + NdotL * material.color.rgb + specular * vec3f(0.3);
    return vec4f(litColor, material.color.a);
}
`;

export class SkinnedPhongMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "SkinnedPhongMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                ],
            });
        }
        return this.materialLayout;
    }

    private static createPipeline(ctx: PipelineContext): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "SkinnedPhongMaterial shader",
                code: SKINNED_PHONG_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "SkinnedPhongMaterial",
            layout: device.createPipelineLayout({
                label: "SkinnedPhongMaterial pipeline layout",
                //0 frame, 1 objeto (array<SkinObject>), 2 material
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [SkinnedMesh.vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [{ format: ctx.colorFormat }],
            },
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        });
    }

    //---- nível da INSTÂNCIA: os parâmetros deste material ----
    //Mesmo layout do PhongColorMaterial: 8 floats / 32 bytes contíguos.
    //  [0..3] color rgba | [4..6] ambient rgb | [7] specular (expoente)
    private static readonly FLOATS = 8;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(SkinnedPhongMaterial.FLOATS);

    constructor(
        device: GPUDevice,
        color: [number, number, number, number] = [1, 1, 1, 1],
        ambient: [number, number, number] = [0.05, 0.05, 0.05],
        specular = 32,
    ) {
        super();
        this.device = device;
        this.paramsBuffer = device.createBuffer({
            label: "SkinnedPhongMaterial params",
            size: SkinnedPhongMaterial.FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "SkinnedPhongMaterial instance",
            layout: SkinnedPhongMaterial.getMaterialBindGroupLayout(device),
            entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
        });
        this.params.set(color, 0);
        this.params.set(ambient, 4);
        this.params[7] = specular;
        this.upload();
    }

    setColor(r: number, g: number, b: number, a = 1): void {
        this.params[0] = r;
        this.params[1] = g;
        this.params[2] = b;
        this.params[3] = a;
        this.upload();
    }

    private upload(): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    //Só existe a variante Skinned: o material é exclusivo de meshes skinnadas.
    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Skinned) {
            throw new Error("SkinnedPhongMaterial só desenha meshes Skinned.");
        }
        let pipeline = SkinnedPhongMaterial.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = SkinnedPhongMaterial.createPipeline(ctx);
            SkinnedPhongMaterial.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    override destroy(): void {
        this.paramsBuffer.destroy();
    }
}
