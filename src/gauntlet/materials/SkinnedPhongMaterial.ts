//Fork do SkinnedPhongMaterial (skinning/SkinnedPhongMaterial.ts) pro
//Gauntlet: mesmo Blinn-Phong com linear blend skinning, mas o grupo 0 agora
//tem N luzes de cada tipo em vez de 1 luz hardcoded tratada como direção —
//ver gauntletLighting.ts. Só roda no GauntletSkinnedRenderPass — o grupo 1
//dele é o array de SkinObject (matrizes de osso por objeto).
//
//Fork EXCLUSIVO do Gauntlet (não compartilhado com o SkinningDemoWorld) pelo
//mesmo motivo do PhongColorMaterial: o pipeline cache de Material é static
//por classe, e o grupo 0 do Gauntlet (4 bindings) não é layout-compatível
//com o dos outros mundos (1 binding).
import { Material, type PipelineContext } from "../../material";
import { MeshType, SkinnedMesh } from "../../mesh";
import { MAX_BONES } from "../../skin";

const SKINNED_PHONG_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
    lightCounts: vec4u, //x=numPoint, y=numSpot, z=numDirectional, w=reservado
};
struct PointLight {
    position: vec3f,
    intensity: f32,
    color: vec3f,
    _pad0: f32,
};
struct SpotLight {
    position: vec3f,
    intensity: f32,
    direction: vec3f,
    cosOuter: f32,
    color: vec3f,
    cosInner: f32,
    shadowViewProj: mat4x4f,
    //3 escalares, NÃO um vec3f: vec3f exige alinhamento de 16 bytes e
    //empurraria o campo (e o tamanho do struct inteiro) 12 bytes adiante,
    //dessincronizando do stride calculado no lado da CPU (FLOATS_PER_SPOT).
    shadowIndex: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
struct DirectionalLight {
    direction: vec3f,
    intensity: f32,
    color: vec3f,
    shadowIndex: f32,
    shadowViewProj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(0) @binding(2) var<storage, read> spotLights: array<SpotLight>;
@group(0) @binding(3) var<storage, read> directionalLights: array<DirectionalLight>;
@group(0) @binding(4) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(5) var directionalShadowMap: texture_depth_2d_array;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
//Um objeto skinnado = dois arrays de ${MAX_BONES} matrizes:
//  pose  — matriz de skinning do osso (boneWorld · inverseBind). É a que
//          deforma o vértice; no bind pose vira identidade.
//  boneModel — model matrix crua do osso (boneWorld). Não usada no skinning
//          básico; fica disponível pra attachments/debug de esqueleto.
struct SkinObject {
    pose: array<mat4x4f, ${MAX_BONES}>,
    boneModel: array<mat4x4f, ${MAX_BONES}>,
};
struct MaterialParams {
    color: vec4f,
    ambient: vec3f,
    specular: f32, //expoente de brilho (shininess)
};
@group(1) @binding(0) var<storage, read> objects: array<SkinObject>;
@group(2) @binding(0) var<uniform> material: MaterialParams;

fn sampleShadowPCF(map: texture_depth_2d_array, layer: i32, uv: vec2f, refDepth: f32) -> f32 {
    let dims = textureDimensions(map);
    let texel = 1.0 / vec2f(f32(dims.x), f32(dims.y));
    var sum = 0.0;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
            //Level (não Compare puro): a versão sem LOD explícito só pode
            //ser chamada em fluxo de controle uniforme, e isto está dentro
            //de 2 loops (o das luzes + o do PCF) — ilegal. Shadow map não
            //tem mipmap mesmo, então nível 0 é sempre o certo.
            sum = sum + textureSampleCompareLevel(map, shadowSampler, uv + vec2f(f32(dx), f32(dy)) * texel, layer, refDepth);
        }
    }
    return sum / 9.0;
}

fn shadowFactor(worldPos: vec3f, shadowViewProj: mat4x4f, shadowIndex: f32, map: texture_depth_2d_array) -> f32 {
    let clip = shadowViewProj * vec4f(worldPos, 1.0);
    if (clip.w <= 0.0) {
        return 1.0;
    }
    let ndc = clip.xyz / clip.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
        return 1.0;
    }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return sampleShadowPCF(map, i32(shadowIndex), uv, ndc.z);
}

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
    let m =
        objects[instance].pose[joints.x] * weights.x +
        objects[instance].pose[joints.y] * weights.y +
        objects[instance].pose[joints.z] * weights.z +
        objects[instance].pose[joints.w] * weights.w;

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
    let V = normalize(frame.cameraPos.xyz - in.worldPosition);

    var diffuse = vec3f(0.0);
    var specular = vec3f(0.0);

    for (var i = 0u; i < frame.lightCounts.x; i = i + 1u) {
        let light = pointLights[i];
        var L = light.position - in.worldPosition;
        let dist = length(L);
        L = L / dist;
        let atten = light.intensity / dist;
        let NdotL = saturate(dot(N, L));
        let H = normalize(L + V);
        let spec = select(0.0, pow(saturate(dot(N, H)), material.specular), NdotL > 0.0);
        diffuse += NdotL * light.color * atten;
        specular += spec * light.color * atten;
    }

    for (var i = 0u; i < frame.lightCounts.y; i = i + 1u) {
        let light = spotLights[i];
        var L = light.position - in.worldPosition;
        let dist = length(L);
        L = L / dist;
        let atten = light.intensity / dist;
        let cosAngle = dot(light.direction, -L);
        let cone = smoothstep(light.cosOuter, light.cosInner, cosAngle);
        let NdotL = saturate(dot(N, L));
        let H = normalize(L + V);
        let spec = select(0.0, pow(saturate(dot(N, H)), material.specular), NdotL > 0.0);
        let shadow = shadowFactor(in.worldPosition, light.shadowViewProj, light.shadowIndex, spotShadowMap);
        diffuse += NdotL * light.color * atten * cone * shadow;
        specular += spec * light.color * atten * cone * shadow;
    }

    for (var i = 0u; i < frame.lightCounts.z; i = i + 1u) {
        let light = directionalLights[i];
        let L = -light.direction;
        let NdotL = saturate(dot(N, L));
        let H = normalize(L + V);
        let spec = select(0.0, pow(saturate(dot(N, H)), material.specular), NdotL > 0.0);
        let shadow = shadowFactor(in.worldPosition, light.shadowViewProj, light.shadowIndex, directionalShadowMap);
        diffuse += NdotL * light.color * light.intensity * shadow;
        specular += spec * light.color * light.intensity * shadow;
    }

    //composição preservada: ambiente aditivo + difuso tingido pela cor do
    //material + especular com tint fixo de 0.3 (igual ao original)
    let litColor = material.ambient + diffuse * material.color.rgb + specular * vec3f(0.3);
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
                label: "Gauntlet SkinnedPhongMaterial material",
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
                label: "Gauntlet SkinnedPhongMaterial shader",
                code: SKINNED_PHONG_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "Gauntlet SkinnedPhongMaterial",
            layout: device.createPipelineLayout({
                label: "Gauntlet SkinnedPhongMaterial pipeline layout",
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
            label: "Gauntlet SkinnedPhongMaterial params",
            size: SkinnedPhongMaterial.FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "Gauntlet SkinnedPhongMaterial instance",
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
