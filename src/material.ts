//Material: o elo entre o Renderable e a GPU. É aqui que mora o
//GPURenderPipeline — pipeline e material não se separam porque o pipeline
//é exatamente "o shader + estado de render de um TIPO de material".
//
//A chave pra visualizar a divisão:
//
//  TIPO de material (a subclasse)   → GPURenderPipeline
//    shader WGSL, blend, cull...      um por (subclasse, formato de vértice),
//                                     em cache ESTÁTICO da subclasse:
//                                     todas as instâncias compartilham.
//
//  INSTÂNCIA de material (o objeto) → uniform buffer + GPUBindGroup
//    cor, texturas, parâmetros...     próprios de cada instância.
//
//Convenção de bind groups, a mesma para todo shader de mesh:
//  grupo 0 = frame   (câmera: view e proj)     — dono: render pass
//  grupo 1 = objeto  (model matrix)            — dono: render pass
//  grupo 2 = material (parâmetros, texturas)   — dono: a instância de Material
import { MeshType, StaticMesh, SkinnedMesh } from "./mesh";

export const BIND_GROUP_FRAME = 0;
export const BIND_GROUP_OBJECT = 1;
export const BIND_GROUP_MATERIAL = 2;

//Tudo que a criação de um pipeline precisa saber do mundo exterior.
//Quem monta isto é o render pass que vai desenhar (mesh pass, transparent
//slices...): é ele que conhece o formato do attachment onde vai desenhar
//e é o dono dos layouts dos grupos 0 e 1. Os layouts que os passes criam
//são estruturalmente idênticos, então o pipeline cacheado (static, por
//tipo de material) vale em qualquer um deles.
export interface PipelineContext {
    device: GPUDevice;
    /** Formato do color attachment em que as meshes serão desenhadas. */
    colorFormat: GPUTextureFormat;
    /** Formato do depth attachment do pass de meshes. */
    depthFormat: GPUTextureFormat;
    frameBindGroupLayout: GPUBindGroupLayout;
    objectBindGroupLayout: GPUBindGroupLayout;
}

//Registry nome → instância de Material, no molde do registry de
//behaviours: o createWorld registra suas instâncias ANTES do loadGltf,
//e o loader usa a custom property "MaterialName" do Blender pra ligar
//cada renderable ao material certo.
const materialRegistry = new Map<string, Material>();

export function registerMaterial(name: string, material: Material): void {
    materialRegistry.set(name, material);
}

export function getMaterial(name: string): Material | undefined {
    return materialRegistry.get(name);
}

/**
 * Destrói e desregistra todos os materiais. Chamado pelo World.destroy():
 * como o registry é global e só existe um mundo vivo por vez, trocar de
 * mundo exige esvaziá-lo — senão o próximo mundo herda materiais órfãos
 * (e um registerMaterial de nome igual vazaria os buffers do antigo).
 */
export function destroyRegisteredMaterials(): void {
    for (const material of materialRegistry.values()) {
        material.destroy();
    }
    materialRegistry.clear();
}

export abstract class Material {
    /**
     * Pipeline do TIPO deste material para o formato de vértice dado.
     * Contrato: a implementação cacheia em membro static — instâncias
     * diferentes do mesmo material devolvem o MESMO objeto, e o render
     * pass pode ordenar os draws por pipeline sem medo.
     */
    abstract getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline;

    /** Bind group (grupo 2) com os buffers/texturas DESTA instância. */
    abstract getBindGroup(): GPUBindGroup;

    /**
     * Libera os recursos de GPU DESTA instância (buffers, texturas).
     * O que é do TIPO (pipelines, shader modules, layouts em cache static)
     * fica — não tem destroy explícito em WebGPU e vale pra vida da app.
     */
    destroy(): void {}
}

//------------------------------------------------------------------------
//UnshadedOpaque: cor sólida, sem luz, sem blend. O material mais simples
//possível — serve de gabarito de como implementar os próximos.
//------------------------------------------------------------------------

//view e proj separadas no Frame: sombra e iluminação vão precisar delas
//individualmente (posição da câmera, espaço de view), então nenhum shader
//recebe a viewProj pré-combinada — compõe proj * view * model ele mesmo.
const UNSHADED_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
struct MaterialParams {
    color: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
//Todas as model matrices do frame, na ordem de draw. Cada draw recebe seu
//slot pelo firstInstance do drawIndexed, que chega aqui como instance_index.
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;
@group(2) @binding(0) var<uniform> material: MaterialParams;

@vertex
fn vs(
    @location(0) position: vec3f,
    @builtin(instance_index) instance: u32,
) -> @builtin(position) vec4f {
    return frame.proj * frame.view * models[instance] * vec4f(position, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
    return material.color;
}
`;

export class UnshadedOpaque extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    //(o cache assume um device e um colorFormat únicos na aplicação)
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "UnshadedOpaque material",
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
                label: "UnshadedOpaque shader",
                code: UNSHADED_WGSL,
            });
        }
        //O shader só lê a posição (location 0); os demais atributos do
        //layout ficam sem uso, o que é permitido. Skinned desenha rígido
        //até existir o sistema de animação.
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `UnshadedOpaque (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "UnshadedOpaque pipeline layout",
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

    //---- nível da INSTÂNCIA: os buffers desta cor específica ----
    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;

    constructor(device: GPUDevice, color: [number, number, number, number] = [1, 1, 1, 1]) {
        super();
        this.device = device;
        //vec4f color — uniform buffers pedem tamanho múltiplo de 16
        this.paramsBuffer = device.createBuffer({
            label: "UnshadedOpaque params",
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "UnshadedOpaque instance",
            layout: UnshadedOpaque.getMaterialBindGroupLayout(device),
            entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
        });
        this.setColor(...color);
    }

    setColor(r: number, g: number, b: number, a = 1): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([r, g, b, a]));
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        let pipeline = UnshadedOpaque.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = UnshadedOpaque.createPipeline(ctx, meshType);
            UnshadedOpaque.pipelines.set(meshType, pipeline);
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

//------------------------------------------------------------------------
//UnshadedTextured: textura diffuse, sem luz. Primeiro material que
//consome os UVs (location 2) que o loader intercala nos vértices.
//------------------------------------------------------------------------

const TEXTURED_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;
@group(2) @binding(0) var texSampler: sampler;
@group(2) @binding(1) var diffuse: texture_2d<f32>;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

//Lê posição (0) e uv (2); a normal (1) fica sem uso, o que é permitido.
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(2) uv: vec2f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    out.position = frame.proj * frame.view * models[instance] * vec4f(position, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    return textureSample(diffuse, texSampler, in.uv);
}
`;

export class UnshadedTextured extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "UnshadedTextured material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                ],
            });
        }
        return this.materialLayout;
    }

    //Sampler é imutável e sem estado por instância — um só pra classe toda.
    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "UnshadedTextured sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "repeat",
                addressModeV: "repeat",
            });
        }
        return this.sampler;
    }

    private static createPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "UnshadedTextured shader",
                code: TEXTURED_WGSL,
            });
        }
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `UnshadedTextured (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "UnshadedTextured pipeline layout",
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
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        });
    }

    //---- nível da INSTÂNCIA: a textura desta instância ----
    private readonly texture: GPUTexture;
    private readonly bindGroup: GPUBindGroup;

    /** O material assume a posse da textura (destroy() a libera junto). */
    constructor(device: GPUDevice, texture: GPUTexture) {
        super();
        this.texture = texture;
        this.bindGroup = device.createBindGroup({
            label: "UnshadedTextured instance",
            layout: UnshadedTextured.getMaterialBindGroupLayout(device),
            entries: [
                { binding: 0, resource: UnshadedTextured.getSampler(device) },
                { binding: 1, resource: this.texture.createView() },
            ],
        });
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        let pipeline = UnshadedTextured.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = UnshadedTextured.createPipeline(ctx, meshType);
            UnshadedTextured.pipelines.set(meshType, pipeline);
        }
        return pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera a textura desta instância na GPU. */
    override destroy(): void {
        this.texture.destroy();
    }
}
