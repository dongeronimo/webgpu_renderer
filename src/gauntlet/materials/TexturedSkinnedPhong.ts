import { Material, type PipelineContext } from "../../material";
import { MeshType, SkinnedMesh } from "../../mesh";
import { MAX_BONES } from "../../skin";

/**
 * Fusão de SkinnedPhongMaterial (matriz de skinning via joints/weights, grupo
 * 1 = SkinObject) com TexturedOpaquePhong (textura diffuse/specular opcional,
 * grupo 2). Faltava — Dmitry/Nat usavam TexturedOpaquePhong (que só declara
 * position/normal/uv e lê `objects[instance].model` como se o grupo 1 fosse
 * ObjectData{model,normalMatrix}), mas quem os desenha é o
 * GauntletSkinnedRenderPass, cujo grupo 1 é SkinObject{pose[],boneModel[]} —
 * um struct TOTALMENTE diferente no mesmo binding. O shader nunca lia
 * joints/weights (T-pose sempre, skinning é no-op) e "model"/"normalMatrix"
 * na prática liam pose[0]/pose[1] (a matriz de skinning do OSSO 0) por cima
 * do buffer errado — daí o corpo inteiro (ainda em bind pose) balançando
 * junto com a sutil animação daquele osso. Só existe a variante Skinned
 * (mesmo espírito de SkinnedPhongMaterial.getPipeline) — pra mesh estática
 * com textura, use TexturedOpaquePhong.
 */
const TEXTURED_SKINNED_PHONG_WGSL = /* wgsl */ `
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
//Grupo 1 = SkinObject (o mesmo layout de SkinnedPhongMaterial — quem desenha
//isto SEMPRE é o GauntletSkinnedRenderPass), não ObjectData{model,normalMatrix}.
struct SkinObject {
    pose: array<mat4x4f, ${MAX_BONES}>,
    boneModel: array<mat4x4f, ${MAX_BONES}>,
};
@group(1) @binding(0) var<storage, read> objects: array<SkinObject>;
struct MaterialParams {
    diffuseColor: vec4f,
    specularColor: vec3f,
    shininess: f32,
    ambient: vec3f,
};
@group(2) @binding(0) var<uniform> material: MaterialParams;
@group(2) @binding(1) var texSampler: sampler;
@group(2) @binding(2) var diffuseTex: texture_2d<f32>;
@group(2) @binding(3) var specularTex: texture_2d<f32>;

fn sampleShadowPCF(map: texture_depth_2d_array, layer: i32, uv: vec2f, refDepth: f32) -> f32 {
    let dims = textureDimensions(map);
    let texel = 1.0 / vec2f(f32(dims.x), f32(dims.y));
    var sum = 0.0;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
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
    @location(2) uv: vec2f,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    //Matriz de skinning combinada: média ponderada das poses das 4 juntas
    //que influenciam o vértice — mesma conta de SkinnedPhongMaterial.
    let m =
        objects[instance].pose[joints.x] * weights.x +
        objects[instance].pose[joints.y] * weights.y +
        objects[instance].pose[joints.z] * weights.z +
        objects[instance].pose[joints.w] * weights.w;

    let worldPos = m * vec4f(position, 1.0);
    var out: VsOut;
    out.worldPosition = worldPos.xyz;
    out.worldNormal = (m * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    out.uv = uv;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let albedo = textureSample(diffuseTex, texSampler, in.uv) * material.diffuseColor;
    let specTint = textureSample(specularTex, texSampler, in.uv).rgb * material.specularColor;

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
        let spec = select(0.0, pow(saturate(dot(N, H)), material.shininess), NdotL > 0.0);
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
        let spec = select(0.0, pow(saturate(dot(N, H)), material.shininess), NdotL > 0.0);
        let shadow = shadowFactor(in.worldPosition, light.shadowViewProj, light.shadowIndex, spotShadowMap);
        diffuse += NdotL * light.color * atten * cone * shadow;
        specular += spec * light.color * atten * cone * shadow;
    }

    for (var i = 0u; i < frame.lightCounts.z; i = i + 1u) {
        let light = directionalLights[i];
        let L = -light.direction;
        let NdotL = saturate(dot(N, L));
        let H = normalize(L + V);
        let spec = select(0.0, pow(saturate(dot(N, H)), material.shininess), NdotL > 0.0);
        let shadow = shadowFactor(in.worldPosition, light.shadowViewProj, light.shadowIndex, directionalShadowMap);
        diffuse += NdotL * light.color * light.intensity * shadow;
        specular += spec * light.color * light.intensity * shadow;
    }

    let litColor = material.ambient * albedo.rgb + diffuse * albedo.rgb + specular * specTint;
    return vec4f(litColor, albedo.a);
}
`;

export interface TexturedSkinnedPhongOptions {
    /** O material assume a posse (destroy() a libera). Ausente = usa diffuseColor. */
    diffuseTexture?: GPUTexture;
    /** Sem textura: a cor do material. Com textura: tint (default branco = neutro). */
    diffuseColor?: [number, number, number, number];
    /** O material assume a posse (destroy() a libera). Ausente = usa specularColor. */
    specularTexture?: GPUTexture;
    /** Sem textura: cor do brilho (default branco). */
    specularColor?: [number, number, number];
    /** Expoente de brilho (shininess): maior = brilho mais concentrado. */
    shininess?: number;
    ambient?: [number, number, number];
}

export class TexturedSkinnedPhong extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static whiteTexture: GPUTexture | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "TexturedSkinnedPhong material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                ],
            });
        }
        return this.materialLayout;
    }

    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "TexturedSkinnedPhong sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "repeat",
                addressModeV: "repeat",
            });
        }
        return this.sampler;
    }

    private static getWhiteTexture(device: GPUDevice): GPUTexture {
        if (!this.whiteTexture) {
            this.whiteTexture = device.createTexture({
                label: "TexturedSkinnedPhong white 1x1",
                size: [1, 1],
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture(
                { texture: this.whiteTexture },
                new Uint8Array([255, 255, 255, 255]),
                {},
                { width: 1, height: 1 },
            );
        }
        return this.whiteTexture;
    }

    private static createPipeline(ctx: PipelineContext): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "TexturedSkinnedPhong shader",
                code: TEXTURED_SKINNED_PHONG_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "TexturedSkinnedPhong",
            layout: device.createPipelineLayout({
                label: "TexturedSkinnedPhong pipeline layout",
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

    //---- nível da INSTÂNCIA: params + texturas desta instância ----
    //Mesmo layout de TexturedOpaquePhong: 12 floats / 48 bytes contíguos.
    private static readonly FLOATS = 12;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(TexturedSkinnedPhong.FLOATS);
    private readonly ownedTextures: GPUTexture[] = [];

    constructor(device: GPUDevice, options: TexturedSkinnedPhongOptions = {}) {
        super();
        this.device = device;
        this.paramsBuffer = device.createBuffer({
            label: "TexturedSkinnedPhong params",
            size: TexturedSkinnedPhong.FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const white = TexturedSkinnedPhong.getWhiteTexture(device);
        if (options.diffuseTexture) this.ownedTextures.push(options.diffuseTexture);
        if (options.specularTexture) this.ownedTextures.push(options.specularTexture);
        this.bindGroup = device.createBindGroup({
            label: "TexturedSkinnedPhong instance",
            layout: TexturedSkinnedPhong.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: TexturedSkinnedPhong.getSampler(device) },
                { binding: 2, resource: (options.diffuseTexture ?? white).createView() },
                { binding: 3, resource: (options.specularTexture ?? white).createView() },
            ],
        });

        this.params.set(options.diffuseColor ?? [1, 1, 1, 1], 0);
        this.params.set(options.specularColor ?? [1, 1, 1], 4);
        this.params[7] = options.shininess ?? 32;
        this.params.set(options.ambient ?? [0.03, 0.03, 0.03], 8);
        this.upload();
    }

    setDiffuseColor(r: number, g: number, b: number, a = 1): void {
        this.params[0] = r;
        this.params[1] = g;
        this.params[2] = b;
        this.params[3] = a;
        this.upload();
    }

    setSpecularColor(r: number, g: number, b: number): void {
        this.params[4] = r;
        this.params[5] = g;
        this.params[6] = b;
        this.upload();
    }

    setShininess(exponent: number): void {
        this.params[7] = exponent;
        this.upload();
    }

    setAmbient(r: number, g: number, b: number): void {
        this.params[8] = r;
        this.params[9] = g;
        this.params[10] = b;
        this.upload();
    }

    private upload(): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    //Só existe a variante Skinned: mesmo espírito de SkinnedPhongMaterial —
    //pra mesh estática com textura, use TexturedOpaquePhong.
    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Skinned) {
            throw new Error("TexturedSkinnedPhong só desenha meshes Skinned.");
        }
        let pipeline = TexturedSkinnedPhong.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = TexturedSkinnedPhong.createPipeline(ctx);
            TexturedSkinnedPhong.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    override destroy(): void {
        this.paramsBuffer.destroy();
        for (const texture of this.ownedTextures) {
            texture.destroy();
        }
    }
}
