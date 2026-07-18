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
 * Espera do render pass (MainRenderPass) os grupos 0 (Frame: view, proj,
 * cameraPos, light0Pos) e 1 (ObjectData[]: model, normalMatrix), então só
 * funciona nesse pass — não no MeshRenderPass comum.
 */
const TEXTURED_OPAQUE_PHONG_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
    light0Pos: vec4f,
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
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;
@group(2) @binding(0) var<uniform> material: MaterialParams;
@group(2) @binding(1) var texSampler: sampler;
@group(2) @binding(2) var diffuseTex: texture_2d<f32>;
@group(2) @binding(3) var specularTex: texture_2d<f32>;

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
    let light0Intensity = vec3f(1.0, 1.0, 1.0); //TODO fazer isso ser propriedade do frame
    //mesma potência global calibrada do PhongColorMaterial (TODO idem: frame/luz)
    let light0Power = 250.0;

    //textura × cor: com a branca 1×1 no lugar da textura ausente isto é a cor pura
    let albedo = textureSample(diffuseTex, texSampler, in.uv) * material.diffuseColor;
    let specTint = textureSample(specularTex, texSampler, in.uv).rgb * material.specularColor;

    //a interpolação entre vértices desnormaliza — renormaliza por fragmento
    let N = normalize(in.worldNormal);

    //vetor até a luz + atenuação. length dá a distância; reaproveito pra normalizar
    var lightDir = frame.light0Pos.xyz - in.worldPosition;
    let distance = length(lightDir);
    lightDir = lightDir / distance;
    let attenuation = light0Power / distance; //linear; troque por /(distance*distance) pra 1/d² físico

    //difuso (Lambert)
    let NdotL = saturate(dot(N, lightDir));
    let diffuse = NdotL * light0Intensity * attenuation;

    //especular (Blinn-Phong: half-vector entre luz e câmera)
    let viewDir = normalize(frame.cameraPos.xyz - in.worldPosition);
    let h = normalize(lightDir + viewDir);
    let NdotH = saturate(dot(N, h));
    //só há brilho onde a face vê a luz (NdotL>0), senão o especular vaza no lado escuro
    let specularIntensity = select(0.0, pow(NdotH, material.shininess), NdotL > 0.0);
    let specular = specularIntensity * light0Intensity * attenuation * specTint;

    //ambiente MULTIPLICA o albedo (difere do PhongColorMaterial, que soma cru):
    //ambiente aditivo apagaria a textura nas áreas sem luz direta
    let litColor = material.ambient * albedo.rgb + diffuse * albedo.rgb + specular;
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
