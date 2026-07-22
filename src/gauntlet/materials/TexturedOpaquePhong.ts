import { Material, type PipelineContext } from "../../material";
import { MeshType, StaticMesh, SkinnedMesh } from "../../mesh";

/**
 * Phong opaco com diffuse e specular vindos de TEXTURA OU COR — o casamento
 * do PhongColorMaterial (iluminação) com o UnshadedTextured (amostragem).
 *
 * O truque do "opcional": não existem variantes de pipeline com/sem textura.
 * O shader SEMPRE amostra as duas texturas e multiplica pela cor; quando uma
 * textura não é fornecida, entra no lugar dela uma branca 1×1 compartilhada
 * do TIPO, e o produto degenera pra cor pura. Com textura, a cor vira tint
 * (o default branco = sem tint). Um pipeline só cobre os quatro combos.
 *
 * Espera do render pass (GauntletMainRenderPass) os grupos 0 (Frame + os 3
 * storage buffers de luz — ver gauntletLighting.ts) e 1 (ObjectData[]:
 * model, normalMatrix), então só funciona nesse pass.
 */
const TEXTURED_OPAQUE_PHONG_WGSL = /* wgsl */ `
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
struct ObjectData {
    model: mat4x4f,
    normalMatrix: mat4x4f,
};
struct MaterialParams {
    diffuseColor: vec4f,   //sem textura = a cor final; com textura = tint
    specularColor: vec3f,  //idem, pro brilho
    shininess: f32,        //expoente de brilho; NÃO é a cor do especular
    ambient: vec3f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(0) @binding(2) var<storage, read> spotLights: array<SpotLight>;
@group(0) @binding(3) var<storage, read> directionalLights: array<DirectionalLight>;
@group(0) @binding(4) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(5) var directionalShadowMap: texture_depth_2d_array;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;
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
    @location(2) uv: vec2f,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    //posição em mundo: precisa do vec4 (w=1) tanto pra saída quanto pro clip
    let worldPos = objects[instance].model * vec4f(position, 1.0);
    out.worldPosition = worldPos.xyz;
    //normal é DIREÇÃO (w=0) e vai pela normalMatrix = transpose(inverse(model)),
    //que é quem preserva perpendicularidade sob escala não-uniforme
    out.worldNormal = (objects[instance].normalMatrix * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    out.uv = uv;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //textura × cor: com a branca 1×1 no lugar da textura ausente isto é a cor pura
    let albedo = textureSample(diffuseTex, texSampler, in.uv) * material.diffuseColor;
    let specTint = textureSample(specularTex, texSampler, in.uv).rgb * material.specularColor;

    //a interpolação entre vértices desnormaliza — renormaliza por fragmento
    let N = normalize(in.worldNormal);
    let V = normalize(frame.cameraPos.xyz - in.worldPosition);

    var diffuse = vec3f(0.0);
    var specular = vec3f(0.0);

    for (var i = 0u; i < frame.lightCounts.x; i = i + 1u) {
        let light = pointLights[i];
        var L = light.position - in.worldPosition;
        let dist = length(L);
        L = L / dist;
        let atten = light.intensity / dist; //linear; troque por /(dist*dist) pra 1/d² físico
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

    //ambiente MULTIPLICA o albedo (difere do PhongColorMaterial, que soma cru):
    //ambiente aditivo apagaria a textura nas áreas sem luz direta
    let litColor = material.ambient * albedo.rgb + diffuse * albedo.rgb + specular * specTint;
    return vec4f(litColor, albedo.a);
}
`;

export interface TexturedOpaquePhongOptions {
    /** O material assume a posse (destroy() a libera). Ausente = usa diffuseColor. */
    diffuseTexture?: GPUTexture;
    /** Sem textura: a cor do material. Com textura: tint (default branco = neutro). */
    diffuseColor?: [number, number, number, number];
    /** O material assume a posse (destroy() a libera). Ausente = usa specularColor. */
    specularTexture?: GPUTexture;
    /** Sem textura: cor do brilho (default branco, como no PhongColorMaterial). */
    specularColor?: [number, number, number];
    /** Expoente de brilho (shininess): maior = brilho mais concentrado. */
    shininess?: number;
    ambient?: [number, number, number];
}

export class TexturedOpaquePhong extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    //(o cache assume um device e um colorFormat únicos na aplicação)
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static whiteTexture: GPUTexture | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "TexturedOpaquePhong material",
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

    //Sampler é imutável e sem estado por instância — um só pra classe toda.
    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "TexturedOpaquePhong sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "repeat",
                addressModeV: "repeat",
            });
        }
        return this.sampler;
    }

    //O elemento neutro do "textura × cor": branca 1×1 pro slot sem textura.
    //É do TIPO (como os pipelines) e nunca é destruída — vale pra vida da app.
    private static getWhiteTexture(device: GPUDevice): GPUTexture {
        if (!this.whiteTexture) {
            this.whiteTexture = device.createTexture({
                label: "TexturedOpaquePhong white 1x1",
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

    private static createPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "TexturedOpaquePhong shader",
                code: TEXTURED_OPAQUE_PHONG_WGSL,
            });
        }
        //Lê posição (0), normal (1) e uv (2). Skinned desenha rígido até o
        //pipeline de animação chegar aqui.
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `TexturedOpaquePhong (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "TexturedOpaquePhong pipeline layout",
                //a ordem aqui É a numeração dos grupos: 0 frame, 1 objeto, 2 material
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [{ format: ctx.colorFormat }],
            },
            //glTF define triângulos CCW como frente; o frontFace default ("ccw") bate.
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: true,
                depthCompare: "less", //z de clip menor = mais perto da câmera
            },
        });
    }

    //---- nível da INSTÂNCIA: params + texturas desta instância ----
    //Layout do struct MaterialParams, 12 floats / 48 bytes contíguos:
    //  [0..3] diffuseColor rgba | [4..6] specularColor rgb | [7] shininess
    //  [8..10] ambient rgb | [11] padding (o vec3 final arredonda pra 16)
    private static readonly FLOATS = 12;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(TexturedOpaquePhong.FLOATS);
    //só as texturas PASSADAS (posse desta instância); a branca é do TIPO
    private readonly ownedTextures: GPUTexture[] = [];

    constructor(device: GPUDevice, options: TexturedOpaquePhongOptions = {}) {
        super();
        this.device = device;
        this.paramsBuffer = device.createBuffer({
            label: "TexturedOpaquePhong params",
            size: TexturedOpaquePhong.FLOATS * 4, //48 bytes (múltiplo de 16, ok pra uniform)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const white = TexturedOpaquePhong.getWhiteTexture(device);
        if (options.diffuseTexture) this.ownedTextures.push(options.diffuseTexture);
        if (options.specularTexture) this.ownedTextures.push(options.specularTexture);
        this.bindGroup = device.createBindGroup({
            label: "TexturedOpaquePhong instance",
            layout: TexturedOpaquePhong.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: TexturedOpaquePhong.getSampler(device) },
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

    /** Sem textura diffuse: A cor. Com: tint multiplicativo (branco = neutro). */
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

    /** Expoente de brilho (shininess): maior = brilho mais concentrado. */
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

    //Sobe os 48 bytes inteiros: o struct é pequeno, não vale a pena escrever
    //por campo com offsets.
    private upload(): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        let pipeline = TexturedOpaquePhong.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = TexturedOpaquePhong.createPipeline(ctx, meshType);
            TexturedOpaquePhong.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera o buffer e as texturas que esta instância recebeu (a branca fica). */
    override destroy(): void {
        this.paramsBuffer.destroy();
        for (const texture of this.ownedTextures) {
            texture.destroy();
        }
    }
}
