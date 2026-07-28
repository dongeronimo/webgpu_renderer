import { Material, PipelineContext } from "../../material";
import { MeshType, SkinnedMesh } from "../../mesh";
import { BIND_GROUP_0_LIGHT_SETS, LIGHT_STRUCTS } from "./shader_includes/lights";
import { SHADOW_FACTOR } from "./shader_includes/shadows";
const GRASS_WGSL = /* wgsl */ `
// dados per frame
struct Frame {
    view: mat4x4f, proj:mat4x4f, cameraPos:vec4f, 
    lightCounts: vec4u //ver Skinned Phong pra explicação.
}
${LIGHT_STRUCTS}
@group(0) @binding(0) var<uniform> frame: Frame;
${BIND_GROUP_0_LIGHT_SETS}
@group(0) @binding(4) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(5) var directionalShadowMap: texture_depth_2d_array;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
//Grupo 1 = o pool plano de matrizes de skinning + a tabela de bases por
//instância (mesmo layout de SkinnedPhongMaterial — quem desenha isto SEMPRE é
//o GauntletSkinnedRenderPass), não ObjectData{model,normalMatrix}.
@group(1) @binding(0) var<storage, read> poses: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> boneOffsets: array<u32>;

struct MaterialParams {
    diffuseColor: vec4f,
    specularColor: vec3f,
    shininess: f32,
    ambient: vec3f,
}
@group(2) @binding(0) var<uniform> material: MaterialParams;
@group(2) @binding(1) var texSampler: sampler;
@group(2) @binding(2) var diffuseTex: texture_2d<f32>;
@group(2) @binding(3) var specularTex: texture_2d<f32>;
@group(2) @binding(4) var alphaTex: texture_2d<f32>;

${SHADOW_FACTOR}

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) worldNormal: vec3f,
    @location(1) worldPosition: vec3f,
    @location(2) uv: vec2f,
};
// VERTEX SHADER - é aqui que a gente aplica a skin. Mantenha em mente que toda renderização 
// no nosso renderer é instanciada e que a gente precisa saber o offset da instancia atual
// nos buffers.
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    let base = boneOffsets[instance];  ///o começo dos ossos dessa instância
    //transform dos ossos
    let m = 
        poses[base + joints.x] * weights.x +
        poses[base + joints.y] * weights.y +
        poses[base + joints.z] * weights.z +
        poses[base + joints.w] * weights.w ;
    // a world de um pass skinned é a soma ponderada das matrizes das poses dos ossos, n tem uma
    // "world" explícita como a dos static mesh.    
    let worldPos = m * vec4f(position, 1.0);
    var out: VsOut;
    out.worldPosition = worldPos.xyz;
    out.worldNormal = (m * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    out.uv = uv;
    return out;
}
// FRAGMENT SHADER - Basicamente igual ao do TexturedSkinnedPhong exceto no final, onde 
// a gente usa o alphaMap.
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
    //opacidade vem do alpha map.
    let alpha = textureSample(alphaTex, texSampler, in.uv);
    return vec4f(litColor, alpha.a);
}
`;
/**
 * O material assume a posse das texturas passadas pra ele.
 */
export interface GrassMaterialOptions {
    /** Grass exige diffuse texture */
    diffuseTexture: GPUTexture;
    /** Grass exige alpha texture */
    alphaTexture: GPUTexture;
    /** Sem textura: a cor do material. Com textura: tint (default branco = neutro). */
    diffuseColor?: [number, number, number, number];
    /** O material assume a posse (destroy() a libera). Ausente = usa specularColor. */
    specularTexture?: GPUTexture;
    /** Sem textura: cor do brilho (default branco). */
    specularColor?: [number, number, number];
    /** Expoente de brilho (shininess): maior = brilho mais concentrado. */
    shininess?: number;
    ambient?: [number, number, number];
    /** Abaixo deste alpha o fragmento não bloqueia luz no shadow map (default
     *  0.5) — ver shadowAlphaMask(). Mais alto = sombra mais rala (só o miolo
     *  opaco da folha projeta); mais baixo = sombra mais cheia, e a franja
     *  antialiasada da textura vira sombra sólida. */
    shadowAlphaCutoff?: number;
}
/**
 * Material do grass, baseado no 
 * https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass
 * A alteração que eu farei em relação ao que o artigo propões é o grass ter sua deformação
 * controlada por skin.
 * 
 * O material tem uma textura difuse e uma textura de alpha channel.
 * 
 * Então esse material tem que ser usado no pass de skin (blending é responsabilidade da pipeline,
 * não do renderpass) 
*/
export class GrassMaterial extends Material {
    /// O shader compilado, que nem o vkShaderModule.
    private static shaderModule: GPUShaderModule | null = null;
    /// Cada material tem seu proprio bind group layout. O bind group layout mapeia o que vai em cada
    /// binding. No nosso esquema o bind group 2 é o bind group específico do material. 
    private static materialLayout: GPUBindGroupLayout | null = null;
    /// Todas as texturas usarão o mesmo sampler pq todas são amostradas da mesma forma, 
    // então um sampler só serve pra todas.
    private static sampler: GPUSampler|null = null;
    /// Retorna o bind group de material (group #2). Se não existir ainda, cria.
    private static getMaterialBindGroupLayout(device: GPUDevice) : GPUBindGroupLayout {
        if(!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label:"GrassMaterial bind group layout",
                entries: [
                    {binding:0, visibility: GPUShaderStage.VERTEX| GPUShaderStage.FRAGMENT, buffer:{type:"uniform"}},
                    {binding:1, visibility: GPUShaderStage.FRAGMENT, sampler:{}},
                    {binding:2, visibility: GPUShaderStage.FRAGMENT, texture:{}},
                    {binding:3, visibility: GPUShaderStage.FRAGMENT, texture:{}},
                    {binding:4, visibility: GPUShaderStage.FRAGMENT, texture:{}},
                ]
            })
        }
        return this.materialLayout;
    }
    /// Igual à getMaterialBindGroupLayout, só que pro sampler
    private static getSampler(device: GPUDevice): GPUSampler {
        if(!this.sampler) {
            this.sampler = device.createSampler({
                label: "GrassMaterial sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU:"repeat",
                addressModeV:"repeat"
            });   
        }
        return this.sampler;
    }

    private static createPipeline(ctx: PipelineContext): GPURenderPipeline {
        const {device} = ctx;
        // Lazy-initialize do shader module
        if(!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "GrassMaterial shaderModule",
                code: GRASS_WGSL
            });
        }
        return device.createRenderPipeline({
            label: "GrassMaterial pipeline",
            layout: device.createPipelineLayout({
                label: "GrassMaterial pipeline layout",
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device)
                ],
            }),
            vertex: {
                module: this.shaderModule, 
                entryPoint: "vs",
                buffers: [SkinnedMesh.vertexLayout]
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: ctx.colorFormat,
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        }
                    }]
            },
            primitive: {topology: "triangle-list", cullMode: "none"},
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: true,
                depthCompare: "less"
            }
        })
    }
    private static readonly FLOATS = 12;
    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(GrassMaterial.FLOATS);
    private readonly ownedTextures: GPUTexture[] = [];
    //Guardados pro shadowAlphaMask(): a MESMA textura de alpha que o fragment
    //shader usa pra compor, agora servindo de recorte no shadow map. Uma fonte
    //de verdade só — sombra e silhueta não podem discordar sobre onde tem folha.
    private readonly alphaView: GPUTextureView;
    private readonly shadowAlphaCutoff: number;

    constructor(device: GPUDevice, options:GrassMaterialOptions){
        super();
        this.device = device;
        //Cria o buffer que guarda
        this.paramsBuffer = device.createBuffer({
            label: "GrassMaterial params buffer",
            size: GrassMaterial.FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });  
        const defaultWhiteTexture = Material.getWhiteTexture(device);
        /// assume o controle das texturas
        this.ownedTextures.push(options.alphaTexture);
        this.ownedTextures.push(options.diffuseTexture);
        if(options.specularTexture) 
            this.ownedTextures.push(options.specularTexture)
        //amarra os objetos (resources) às posições no bind group
        this.bindGroup = device.createBindGroup({
            label: "GrassMaterial instance bind group",
            layout: GrassMaterial.getMaterialBindGroupLayout(device),
            entries: [
                { binding:0, resource: {buffer:this.paramsBuffer}},
                { binding:1, resource: GrassMaterial.getSampler(device)},
                { binding:2, resource: options.diffuseTexture.createView()},
                { binding:3, resource: (options.specularTexture ?? defaultWhiteTexture).createView()},
                { binding:4, resource: options.alphaTexture.createView()}
            ]
        });
        this.alphaView = options.alphaTexture.createView();
        this.shadowAlphaCutoff = options.shadowAlphaCutoff ?? 0.5;
        //seta os parâmetros do material
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
    
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();
    
    getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Skinned) {
            throw new Error("GrassMaterial só desenha meshes Skinned.");
        }
        let pipeline = GrassMaterial.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = GrassMaterial.createPipeline(ctx);
            GrassMaterial.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }
    getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /**
     * A grama é o caso que motivou isto existir: sem recorte, cada tufo projeta
     * a sombra do QUAD, não a das folhas — e com milhares de tufos o chão vira
     * um xadrez de chapas retangulares.
     *
     * O cutoff é lido UMA vez, quando o shadow pass monta o bind group deste
     * material; mudar depois não repropaga (é parâmetro de construção, não
     * knob de runtime).
     */
    override shadowAlphaMask() {
        return {
            view: this.alphaView,
            sampler: GrassMaterial.getSampler(this.device),
            cutoff: this.shadowAlphaCutoff,
        };
    }

    override destroy(): void {
        this.paramsBuffer.destroy();
        for (const texture of this.ownedTextures) {
            texture.destroy();
        }
    }
}