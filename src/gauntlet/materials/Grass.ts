import { Material, PipelineContext } from "../../material";
import { MeshType, SkinnedMesh, StaticMesh } from "../../mesh";
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
//Grupo 1 = ObjectData{model, normalMatrix}, o mesmo do TexturedOpaquePhong:
//quem desenha isto é o GauntletMainRenderPass. ERA o pool de poses de skinning
//— ver o comentário da classe pra por que deixou de ser.
struct ObjectData {
    model: mat4x4f,
    normalMatrix: mat4x4f,
};
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;

struct MaterialParams {
    diffuseColor: vec4f,
    specularColor: vec3f,
    shininess: f32,
    ambient: vec3f,
    //alpha < isto = fragmento descartado. MESMO valor que vai pro shadow map
    //(ver shadowAlphaMask): silhueta e sombra têm que concordar sobre onde há
    //folha, senão a sombra não bate com o tufo que a projeta.
    alphaCutoff: f32,
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
// VERTEX SHADER - rígido. Toda renderização no nosso renderer é instanciada, e
// cada tufo pega a matriz dele por instance_index. É aqui que a animação de
// vento vai entrar um dia: deslocar a position em função da altura do vértice
// (o v do uv serve de peso) e do tempo, sem osso nenhum — é assim que o
// artigo do GPU Gems faz.
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    let worldPos = objects[instance].model * vec4f(position, 1.0);
    var out: VsOut;
    out.worldPosition = worldPos.xyz;
    //normal é DIREÇÃO (w=0) e vai pela normalMatrix = transpose(inverse(model)),
    //que preserva perpendicularidade sob escala não-uniforme
    out.worldNormal = (objects[instance].normalMatrix * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    out.uv = uv;
    return out;
}
// FRAGMENT SHADER - Basicamente igual ao do TexturedSkinnedPhong exceto no
// começo, onde a gente RECORTA pelo alphaMap.
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //Recorte, não blend: o fragmento existe inteiro ou não existe. Vem ANTES da
    //iluminação de propósito — o que foi descartado não paga luz nenhuma, e com
    //milhares de tufos isso é a maior parte dos fragmentos.
    if (textureSample(alphaTex, texSampler, in.uv).a < material.alphaCutoff) {
        discard;
    }
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
    //alpha 1: quem chegou até aqui passou no recorte lá em cima e é opaco.
    return vec4f(litColor, 1.0);
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
    /** Abaixo deste alpha o fragmento é DESCARTADO (default 0.5) — tanto ao
     *  desenhar quanto ao projetar sombra, é o mesmo valor nos dois (ver
     *  shadowAlphaMask). Mais alto = folha mais fina, e a franja antialiasada da
     *  textura some; mais baixo = folha mais cheia, com a franja virando borda
     *  dura. É o knob que troca "grama rala e limpa" por "grama cheia e
     *  serrilhada". */
    alphaCutoff?: number;
}
/**
 * Material do grass, baseado no
 * https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass
 *
 * O material tem uma textura diffuse e uma textura de alpha channel, e desenha
 * no GauntletMainRenderPass como qualquer mesh RÍGIDA.
 *
 * ERA SKINNADO, e não é mais. A ideia tinha sido usar skin pra deformar a folha
 * no vento, mas o artigo não faz isso e o preço apareceu na conta: cada tufo
 * virava uma Armature inteira (armature + 3 ossos + o nó da mesh = 5 nodes) e
 * 3600 tufos viravam ~18 mil nodes percorridos todo frame, cada um com pose
 * recalculada e reenviada — no skinned pass E no shadow pass, por luz — pra uma
 * pose que nunca mudava, já que nenhum clip anima a grama. Rígido, é 1 node por
 * tufo, sem pool de poses nenhum. A animação de vento volta pelo vertex shader
 * (ver o comentário no vs), que é como o artigo faz e não custa node nenhum.
 *
 * Transparência é por RECORTE (discard), não por blend — ver o fragment shader
 * e o pipeline.
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

    private static createPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        const {device} = ctx;
        // Lazy-initialize do shader module
        if(!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "GrassMaterial shaderModule",
                code: GRASS_WGSL
            });
        }
        //Os dois layouts são aceitos porque o shader só lê position/normal/uv
        //(locations 0,1,2), que existem em ambos. O grass00.glb ainda exporta
        //JOINTS_0/WEIGHTS_0 do tempo do skinning, então o loader ainda entrega
        //SkinnedMesh — e o stride é diferente, então o layout TEM que
        //acompanhar. Reexportar sem armature faz cair no ramo Static sozinho.
        const vertexLayout = meshType === MeshType.Skinned
            ? SkinnedMesh.vertexLayout
            : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `GrassMaterial pipeline (${MeshType[meshType]})`,
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
                buffers: [vertexLayout]
            },
            //SEM blend: o recorte no fragment já resolveu a transparência, e o
            //resultado é opaco. É o que permite a grama viver no
            //GauntletMainRenderPass, que reordena os draws livremente por
            //(pipeline, material, mesh) — reordenar com blend ligado seria bug
            //de corretude, não otimização.
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [{ format: ctx.colorFormat }]
            },
            //"none" porque folha é quad de duas faces: com back-culling, metade
            //dos tufos desaparece dependendo do yaw sorteado pelo gerador.
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
    private readonly alphaCutoff: number;

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
        this.alphaCutoff = options.alphaCutoff ?? 0.5;
        //seta os parâmetros do material
        this.params.set(options.diffuseColor ?? [1, 1, 1, 1], 0);
        this.params.set(options.specularColor ?? [1, 1, 1], 4);
        this.params[7] = options.shininess ?? 32;
        this.params.set(options.ambient ?? [0.03, 0.03, 0.03], 8);
        //índice 11 era padding do vec3f ambient — o cutoff coube nele sem
        //crescer o buffer (vec3f alinha em 16, o f32 seguinte mora no 4º slot)
        this.params[11] = this.alphaCutoff;
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
        let pipeline = GrassMaterial.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = GrassMaterial.createPipeline(ctx, meshType);
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
            cutoff: this.alphaCutoff,
        };
    }

    override destroy(): void {
        this.paramsBuffer.destroy();
        for (const texture of this.ownedTextures) {
            texture.destroy();
        }
    }
}