//Phong com SOL (luz direcional) + SOMBRAS — o material da geometria do
//gameVolume. É o sucessor do PhongColorMaterial da StarshipDemo pra este
//mundo, com três diferenças:
//  1. luz DIRECIONAL: direção constante, SEM atenuação por distância (o bug
//     do "blink" branco/preto era a potência 250/dist calibrada pra outra
//     escala de cena — com sol isso simplesmente não existe);
//  2. SOMBRA da geometria: projeta o fragmento no clip do sol e compara com o
//     shadow map (PCF 3×3 pra borda macia);
//  3. SOMBRA da FUMAÇA: multiplica a luz direta pela transmitância do
//     SmokeTransmittancePass (sombra cinza, proporcional à densidade).
//
//Classe SEPARADA (não um flag no PhongColorMaterial) de propósito: o cache
//estático de pipelines é POR CLASSE, e o pipeline daqui é criado contra o
//frame layout do SunScenePass (grupo 0 com shadow map + samplers). Reusar a
//classe antiga faria o cache servir um pipeline de layout errado pro mundo
//que rodasse em segundo. Só funciona no SunScenePass.
import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh, SkinnedMesh } from "../mesh";

const SUN_PHONG_WGSL = /*wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
    sunDir: vec4f,          //xyz = direção de PROPAGAÇÃO (sol→cena), w = intensidade
    sunColor: vec4f,        //rgb = cor da luz
    lightViewProj: mat4x4f, //mundo → clip do sol (shadow map e transmitância)
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
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
@group(0) @binding(3) var smokeT: texture_2d<f32>;   //transmitância da fumaça
@group(0) @binding(4) var smokeSamp: sampler;
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
    let worldPos = objects[instance].model * vec4f(position, 1.0);
    out.worldPosition = worldPos.xyz;
    //normal é DIREÇÃO (w=0) e vai pela normalMatrix = transpose(inverse(model))
    out.worldNormal = (objects[instance].normalMatrix * vec4f(normal, 0.0)).xyz;
    out.position = frame.proj * frame.view * worldPos;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let N = normalize(in.worldNormal);
    //Direcional: o vetor ATÉ a luz é a propagação invertida, igual pra cena toda.
    let L = -normalize(frame.sunDir.xyz);
    let NdotL = saturate(dot(N, L));

    //--- sombra: este ponto visto pelo SOL ---
    //Projeção ortho: w=1, o clip JÁ é ndc. O mapeamento ndc→uv (x*0.5+0.5,
    //0.5-y*0.5) é o contrato compartilhado com o shadow pass e a transmitância.
    let lclip = frame.lightViewProj * vec4f(in.worldPosition, 1.0);
    let suv = vec2f(lclip.x * 0.5 + 0.5, 0.5 - lclip.y * 0.5);
    var shadow = 1.0;
    if (all(suv >= vec2f(0.0)) && all(suv <= vec2f(1.0)) && lclip.z >= 0.0 && lclip.z <= 1.0) {
        //PCF 3×3: média de 9 comparações vizinhas = penumbra de ~1 texel.
        //textureSampleCompareLevel (nível explícito) porque estamos em
        //controle de fluxo não-uniforme (o if acima).
        let texel = 1.0 / vec2f(textureDimensions(shadowMap));
        var sum = 0.0;
        for (var y = -1; y <= 1; y = y + 1) {
            for (var x = -1; x <= 1; x = x + 1) {
                sum += textureSampleCompareLevel(
                    shadowMap, shadowSamp,
                    suv + vec2f(f32(x), f32(y)) * texel,
                    lclip.z - 0.0015, //bias de leitura, além do depthBias da escrita
                );
            }
        }
        shadow = sum / 9.0;
    }
    //Sombra da FUMAÇA: transmitância no mesmo uv de light-space. Fora do
    //footprint o clamp devolve a borda (=1.0, sem fumaça lá).
    let smokeTrans = textureSampleLevel(smokeT, smokeSamp, saturate(suv), 0.0).r;

    //Luz direta que efetivamente chega: cor · intensidade · sombras.
    let direct = frame.sunColor.rgb * frame.sunDir.w * shadow * smokeTrans;

    //difuso (Lambert)
    let diffuse = NdotL * direct;

    //especular (Blinn-Phong: half-vector entre luz e câmera)
    let viewDir = normalize(frame.cameraPos.xyz - in.worldPosition);
    let h = normalize(L + viewDir);
    let NdotH = saturate(dot(N, h));
    //só há brilho onde a face vê a luz (NdotL>0), senão o especular vaza no lado escuro
    let specularIntensity = select(0.0, pow(NdotH, material.specular), NdotL > 0.0);
    let specular = specularIntensity * direct;

    //composição: ambiente (imune a sombra — é o fill) + difuso tingido + especular
    let litColor = material.ambient + diffuse * material.color.rgb + specular;
    return vec4f(litColor, material.color.a);
}
`;

export class SunPhongMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static readonly pipelines = new Map<MeshType, GPURenderPipeline>();

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "SunPhongMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                ],
            });
        }
        return this.materialLayout;
    }

    private static createPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "SunPhongMaterial shader",
                code: SUN_PHONG_WGSL,
            });
        }
        const vertexLayout =
            meshType === MeshType.Skinned ? SkinnedMesh.vertexLayout : StaticMesh.vertexLayout;
        return device.createRenderPipeline({
            label: `SunPhongMaterial (${MeshType[meshType]})`,
            layout: device.createPipelineLayout({
                label: "SunPhongMaterial pipeline layout",
                //a ordem É a numeração dos grupos: 0 frame (do SunScenePass,
                //com shadow map + transmitância), 1 objeto, 2 material
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

    //---- nível da INSTÂNCIA: mesmos parâmetros do PhongColorMaterial ----
    //Layout do struct MaterialParams (std140), 8 floats / 32 bytes:
    //  [0..3] color rgba | [4..6] ambient rgb | [7] specular (expoente)
    private static readonly FLOATS = 8;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly params = new Float32Array(SunPhongMaterial.FLOATS);

    constructor(
        device: GPUDevice,
        color: [number, number, number, number] = [1, 1, 1, 1],
        ambient: [number, number, number] = [0.03, 0.03, 0.03],
        specular = 32,
    ) {
        super();
        this.device = device;
        this.paramsBuffer = device.createBuffer({
            label: "SunPhongMaterial params",
            size: SunPhongMaterial.FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "SunPhongMaterial instance",
            layout: SunPhongMaterial.getMaterialBindGroupLayout(device),
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

    private upload(): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        let pipeline = SunPhongMaterial.pipelines.get(meshType);
        if (!pipeline) {
            pipeline = SunPhongMaterial.createPipeline(ctx, meshType);
            SunPhongMaterial.pipelines.set(meshType, pipeline);
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
