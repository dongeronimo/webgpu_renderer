import { Material, type PipelineContext } from "../../material";
import { MeshType, StaticMesh, SkinnedMesh } from "../../mesh";

/**
 * Fork do PhongColorMaterial da StarshipDemo pro Gauntlet: mesmo Blinn-Phong,
 * mas o grupo 0 agora tem N luzes de cada tipo (point/spot/directional) em
 * vez de 1 luz hardcoded — ver gauntletLighting.ts pro layout do Frame e dos
 * 3 storage buffers, e o porquê deste fork ser um material EXCLUSIVO do
 * Gauntlet (não compartilhado com StarshipDemo/Train/GameVolume).
 */
const PHONG_COLOR_MATERIAL = /*wgsl */ `
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
    shadowViewProj: mat4x4f, //luz->clip, projeta o fragmento no shadow map
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
    color: vec4f,
    ambient: vec3f,
    specular: f32, //expoente de brilho (shininess); NÃO é a cor do especular
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

//PCF 3x3: soft shadow — a sombra "dura" de 1 amostra ficaria serrilhada e
//instável contra a resolução do shadow map, então tira a média de 9 amostras
//ao redor do texel.
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

//Projeta o fragmento no espaço da luz e compara. Fora do frustum da luz
//(uv/depth fora de [0,1] ou atrás da câmera da sombra) = sem sombra, não
//sombra total — evita uma borda preta feia além do alcance do shadow map.
fn shadowFactor(worldPos: vec3f, shadowViewProj: mat4x4f, shadowIndex: f32, map: texture_depth_2d_array) -> f32 {
    let clip = shadowViewProj * vec4f(worldPos, 1.0);
    if (clip.w <= 0.0) {
        return 1.0;
    }
    let ndc = clip.xyz / clip.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
        return 1.0;
    }
    //clip [-1,1] -> uv [0,1], Y invertido (mesma convenção do finalPass.ts)
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return sampleShadowPCF(map, i32(shadowIndex), uv, ndc.z);
}
struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) worldNormal: vec3f,
    @location(1) worldPosition: vec3f
};
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
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
    return out;
}

@fragment
fn fs(in:VsOut) -> @location(0) vec4f {
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
        //ângulo entre o eixo do cone e a direção luz→fragmento (-L é
        //fragmento→luz invertido = luz→fragmento)
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
        let L = -light.direction; //direction = pra onde os raios viajam; L = pra onde está a luz
        let NdotL = saturate(dot(N, L));
        let H = normalize(L + V);
        let spec = select(0.0, pow(saturate(dot(N, H)), material.specular), NdotL > 0.0);
        let shadow = shadowFactor(in.worldPosition, light.shadowViewProj, light.shadowIndex, directionalShadowMap);
        diffuse += NdotL * light.color * light.intensity * shadow;
        specular += spec * light.color * light.intensity * shadow;
    }

    //composição: ambiente + difuso tingido pela cor do material + especular branco
    let litColor = material.ambient + diffuse * material.color.rgb + specular;
    return vec4f(litColor, material.color.a);
}
`;

//------------------------------------------------------------------------
//PhongColorMaterial: cor sólida iluminada por N luzes point/spot/directional
//(difuso + especular Blinn-Phong + ambiente). Segue o mesmo molde do
//UnshadedOpaque (ver material.ts): o TIPO cacheia pipeline/layout em
//membros static; a INSTÂNCIA tem seu uniform buffer + bind group (grupo 2).
//
//Espera do render pass (GauntletMainRenderPass) os grupos 0 (Frame + os 3
//storage buffers de luz, ver gauntletLighting.ts) e 1 (ObjectData[]: model,
//normalMatrix) — só funciona nesse pass.
//------------------------------------------------------------------------

export class PhongColorMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "Gauntlet PhongColorMaterial material",
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.FRAGMENT,
                        buffer: { type: "uniform" },
                    },
                ],
            });
        }
        return this.materialLayout;
    }

    private static createPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "Gauntlet PhongColorMaterial shader",
                code: PHONG_COLOR_MATERIAL,
            });
        }
        //O shader lê posição (0) e normal (1); a uv (2) da StaticMesh fica sem
        //uso, o que é permitido. Skinned desenha rígido até existir animação.
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `Gauntlet PhongColorMaterial (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "Gauntlet PhongColorMaterial pipeline layout",
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

    //---- nível da INSTÂNCIA: os parâmetros desta cor/material específico ----
    //Layout do struct MaterialParams (std140), 8 floats / 32 bytes contíguos:
    //  [0..3] color rgba | [4..6] ambient rgb | [7] specular (expoente)
    //O specular (f32) encaixa no padding final do vec3 ambient — sem gap.
    private static readonly FLOATS = 8;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(PhongColorMaterial.FLOATS);

    constructor(
        device: GPUDevice,
        color: [number, number, number, number] = [1, 1, 1, 1],
        ambient: [number, number, number] = [0.03, 0.03, 0.03],
        specular = 32,
    ) {
        super();
        this.device = device;
        this.paramsBuffer = device.createBuffer({
            label: "Gauntlet PhongColorMaterial params",
            size: PhongColorMaterial.FLOATS * 4, //32 bytes (múltiplo de 16, ok pra uniform)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "Gauntlet PhongColorMaterial instance",
            layout: PhongColorMaterial.getMaterialBindGroupLayout(device),
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

    setAmbient(r: number, g: number, b: number): void {
        this.params[4] = r;
        this.params[5] = g;
        this.params[6] = b;
        this.upload();
    }

    /** Expoente de brilho (shininess): maior = brilho mais concentrado. */
    setSpecular(exponent: number): void {
        this.params[7] = exponent;
        this.upload();
    }

    //Sobe os 32 bytes inteiros: o struct é pequeno, não vale a pena escrever
    //por campo com offsets.
    private upload(): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        let pipeline = PhongColorMaterial.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = PhongColorMaterial.createPipeline(ctx, meshType);
            PhongColorMaterial.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera o buffer desta instância na GPU. */
    override destroy(): void {
        this.paramsBuffer.destroy();
    }
}
