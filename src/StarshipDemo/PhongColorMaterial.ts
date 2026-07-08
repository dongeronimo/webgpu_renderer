import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh, SkinnedMesh } from "../mesh";

/**
 * Shader phong para uma luz. Pretendo expandi-lo mais tarde para ter shadow maps
 * e mais luzes, mas por enquanto é uma luz, sem sombra
 */
const PHONG_COLOR_MATERIAL = /*wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
    //quando quisermos por mais propriedades de luz e outras luzes teremos que expandir isso.
    light0Pos: vec4f,
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
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;
@group(2) @binding(0) var<uniform> material: MaterialParams;
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
    let light0Intensity = vec3f(1.0, 1.0, 1.0); //TODO fazer isso ser propriedade do frame
    let light0Power = 10.0;                      //TODO fazer isso ser propriedade do frame

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
    let specularIntensity = select(0.0, pow(NdotH, material.specular), NdotL > 0.0);
    let specular = specularIntensity * light0Intensity * attenuation;

    //composição: ambiente + difuso tingido pela cor do material + especular branco
    let litColor = material.ambient + diffuse * material.color.rgb + specular;
    return vec4f(litColor, material.color.a);
}
`;

//------------------------------------------------------------------------
//PhongColorMaterial: cor sólida iluminada por uma luz pontual (difuso +
//especular Blinn-Phong + ambiente). Segue o mesmo molde do UnshadedOpaque
//(ver material.ts): o TIPO cacheia pipeline/layout em membros static; a
//INSTÂNCIA tem seu uniform buffer + bind group (grupo 2).
//
//Espera do render pass (MainRenderPass) os grupos 0 (Frame: view, proj,
//cameraPos, light0Pos) e 1 (ObjectData[]: model, normalMatrix), então só
//funciona nesse pass — não no MeshRenderPass comum.
//------------------------------------------------------------------------

export class PhongColorMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "PhongColorMaterial material",
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
                label: "PhongColorMaterial shader",
                code: PHONG_COLOR_MATERIAL,
            });
        }
        //O shader lê posição (0) e normal (1); a uv (2) da StaticMesh fica sem
        //uso, o que é permitido. Skinned desenha rígido até existir animação.
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `PhongColorMaterial (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "PhongColorMaterial pipeline layout",
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
            label: "PhongColorMaterial params",
            size: PhongColorMaterial.FLOATS * 4, //32 bytes (múltiplo de 16, ok pra uniform)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "PhongColorMaterial instance",
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
