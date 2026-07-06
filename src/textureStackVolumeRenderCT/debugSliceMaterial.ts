//Material de DEBUG das fatias: desenha cada SliceMesh como uma superfície
//OPACA, cor sólida, com shading Phong só DIFFUSE (sem ambient, sem
//specular). Existe pra ENXERGAR as fatias de um ângulo (o DebugSlicesPass
//renderiza de uma câmera deslocada) — nada de composição/CTF/volume aqui.
//
//A diferença central pro TextureStackPrecalculatedMaterial: aquele lê o HU
//e o gradiente da textura 3D; ESTE não toca em textura nenhuma. A cor vem
//de um uniform simples e a NORMAL sai das derivadas de tela do worldPos —
//a SliceMesh só carrega pos+uvw no vértice (24 bytes), não tem normal, e o
//gradiente (que faria esse papel) foi justamente o que abrimos mão.
//
//Contrato de grupos, o mesmo do pass:
//  grupo 0 = Frame (view, proj, cameraPos)   — dono: DebugSlicesPass
//  grupo 1 = objects[] (model + normalMatrix) — dono: DebugSlicesPass
//  grupo 2 = material (cor)                    — dono: esta instância
//
//Só aceita MeshType.VolumeSlice: o vertex layout (pos+uvw) é o da SliceMesh.
import { Material, type PipelineContext } from "../material";
import { MeshType } from "../mesh";
import { SliceMesh } from "../textureStackVolumeRender/sliceMesh";

const DEBUG_SLICE_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    cameraPos: vec4f,
};
//Mesmo slot de instância do bufferzão do pass (model + normalMatrix). Aqui
//só a model é usada; a normal desta técnica é geométrica (ver o fragment).
struct ObjectData {
    model: mat4x4f,
    normalMatrix: mat4x4f,
};
struct MaterialParams {
    color: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> objects: array<ObjectData>;
@group(2) @binding(0) var<uniform> material: MaterialParams;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @location(1) uvw: vec3f, //no layout da SliceMesh, ignorado neste material
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    let world = objects[instance].model * vec4f(position, 1.0);
    out.position = frame.proj * frame.view * world;
    out.worldPos = world.xyz;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //Normal GEOMÉTRICA da fatia sem normal no vértice: dpdx/dpdy dão dois
    //vetores tangentes à superfície neste pixel; o produto vetorial deles é
    //a normal do plano. (Chamado em fluxo uniforme, no topo do fragment.)
    var N = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
    //A fatia é vista dos dois lados (cullMode none, winding flipa conforme
    //a câmera): vira a normal pro lado de quem olha pra iluminar sempre.
    let V = normalize(frame.cameraPos.xyz - in.worldPos);
    if (dot(N, V) < 0.0) {
        N = -N;
    }
    //Luz hardcoded: um pouco ACIMA e ATRÁS da câmera. A 3x3 superior da view
    //é rotação (mundo→view); sua inversa é a transposta, então as LINHAS da
    //view são os eixos da câmera no mundo. In WGSL frame.view[i] é a COLUNA
    //i, logo a linha k = (view[0][k], view[1][k], view[2][k]):
    //  linha 1 (.y) = up da câmera; linha 2 (.z) = +Z de view = ATRÁS de
    //  quem olha (a câmera mira em -Z).
    let camUp = vec3f(frame.view[0].y, frame.view[1].y, frame.view[2].y);
    let camBack = vec3f(frame.view[0].z, frame.view[1].z, frame.view[2].z);
    let lightPos = frame.cameraPos.xyz + camUp * 2.0 + camBack * 3.0;
    let L = normalize(lightPos - in.worldPos);
    //Phong SÓ diffuse: sem ambient (lado oposto vai a preto), sem specular.
    let diffuse = max(dot(N, L), 0.0);
    return vec4f(material.color.rgb * diffuse, 1.0);
}
`;

export class DebugSliceMaterial extends Material {
    //---- nível do TIPO: static, compartilhado por todas as instâncias ----
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "DebugSliceMaterial material",
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
                label: "DebugSliceMaterial shader",
                code: DEBUG_SLICE_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "DebugSliceMaterial (VolumeSlice)",
            layout: device.createPipelineLayout({
                label: "DebugSliceMaterial pipeline layout",
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [SliceMesh.vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                //OPACO: sem blend — cada fatia é uma superfície sólida.
                targets: [{ format: ctx.colorFormat }],
            },
            //cullMode none: o mesmo polígono é visto dos dois lados quando a
            //câmera de debug orbita (o fragment vira a normal pro observador).
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: true, //opaco: fatia mais perto oclui a de trás
                depthCompare: "less",
            },
        });
    }

    //---- nível da INSTÂNCIA: a cor sólida desta instância ----
    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;

    constructor(device: GPUDevice, color: [number, number, number, number] = [0.8, 0.8, 0.85, 1]) {
        super();
        this.device = device;
        //vec4f color — uniform pede tamanho múltiplo de 16
        this.paramsBuffer = device.createBuffer({
            label: "DebugSliceMaterial params",
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.bindGroup = device.createBindGroup({
            label: "DebugSliceMaterial instance",
            layout: DebugSliceMaterial.getMaterialBindGroupLayout(device),
            entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
        });
        this.setColor(...color);
    }

    setColor(r: number, g: number, b: number, a = 1): void {
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([r, g, b, a]));
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.VolumeSlice) {
            throw new Error(
                `DebugSliceMaterial só desenha MeshType.VolumeSlice, recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!DebugSliceMaterial.pipeline) {
            DebugSliceMaterial.pipeline = DebugSliceMaterial.createPipeline(ctx);
        }
        return DebugSliceMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /** Libera o buffer de cor desta instância na GPU. */
    override destroy(): void {
        this.paramsBuffer.destroy();
    }
}
