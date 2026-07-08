//Pass do skybox: pinta o fundo com um cubemap ANTES do mesh pass, no
//mesmo alvo offscreen. Como roda primeiro, é ele quem faz o clear do
//alvo (o mesh pass do mundo passa a usar loadOp:"load") e nem precisa de
//depth attachment — as meshes depois desenham por cima com o depth test
//normal delas.
//
//O cubo vem da árvore do mundo como um Renderable comum, marcado com
//RenderPassBit.Skybox no passMask (e SEM o bit Main — o mesh pass o pula).
//O tamanho do cubo é irrelevante: o VS zera a translação da view, então o
//cubo está sempre centrado na câmera, e cubemap se amostra por DIREÇÃO
//(a posição local do vértice), cuja magnitude não importa.
//
//Autocontido no molde do FinalRenderPass: pipeline, sampler e uniforms
//são do pass, não passam pelo sistema de materiais — skybox não é objeto
//de cena com material, é infra de renderização.
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "./gpuTimer";
import { Node } from "./node";
import { MeshType, StaticMesh } from "./mesh";
import type { Renderable } from "./renderable";
import { RenderPassBit } from "./renderable";

const SKYBOX_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var texSampler: sampler;
@group(1) @binding(1) var cubemap: texture_cube<f32>;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) dir: vec3f,
};

@vertex
fn vs(@location(0) position: vec3f) -> VsOut {
    //View sem translação: mantém as colunas de rotação e zera a de posição.
    //É isso que prende o cubo na câmera — só orientação e perspectiva.
    let rotOnly = mat4x4f(frame.view[0], frame.view[1], frame.view[2], vec4f(0.0, 0.0, 0.0, 1.0));
    var out: VsOut;
    out.position = frame.proj * rotOnly * vec4f(position, 1.0);
    //A direção de amostragem é a posição local do vértice; o fs normaliza
    //depois da interpolação.
    out.dir = position;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    return textureSample(cubemap, texSampler, normalize(in.dir));
}
`;
/**
 * OBS.:
 * O skybox pass, da forma como feita no exemplo do SolarSystem, assume que zNear é 0.1. Naquele exemplo em que
 * fazemos o 1o skybox a gente usa zNear = 0.1 e o cubo unitário (sides 1x1x1). Se o zNear for maior ou mto proximo
 * a 1 a Skybox não vai desenhar pq estará fora do zNear.
 */
export class SkyboxRenderPass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;

    //grupo 0: view + proj, mesmo layout de Frame do mesh pass
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(32);

    //grupo 1: sampler + cubemap. Criado no setCubemap — o pass nasce no
    //createRenderPasses, mas a textura só chega no createWorld (é async).
    private readonly cubemapLayout: GPUBindGroupLayout;
    private readonly sampler: GPUSampler;
    private cubemap: GPUTexture | null = null;
    private cubemapBindGroup: GPUBindGroup | null = null;

    constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
        this.device = device;

        const frameLayout = device.createBindGroupLayout({
            label: "skybox frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ],
        });
        this.frameBuffer = device.createBuffer({
            label: "skybox frame (view + proj)",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "skybox frame",
            layout: frameLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });

        this.cubemapLayout = device.createBindGroupLayout({
            label: "skybox cubemap (grupo 1)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { viewDimension: "cube" },
                },
            ],
        });
        this.sampler = device.createSampler({
            label: "skybox sampler",
            magFilter: "linear",
            minFilter: "linear",
        });

        const module = device.createShaderModule({ label: "skybox shader", code: SKYBOX_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "skybox",
            layout: device.createPipelineLayout({
                label: "skybox pipeline layout",
                bindGroupLayouts: [frameLayout, this.cubemapLayout],
            }),
            vertex: {
                module,
                entryPoint: "vs",
                //o cubo chega pelo gltfLoader como StaticMesh; só a posição
                //(location 0) é lida
                buffers: [StaticMesh.vertexLayout],
            },
            fragment: { module, entryPoint: "fs", targets: [{ format: colorFormat }] },
            //cullMode none: vemos o cubo POR DENTRO, e assim o pass funciona
            //com qualquer winding que a mesh tenha vindo do Blender. São 12
            //triângulos — economizar culling aqui não paga nada.
            primitive: { topology: "triangle-list", cullMode: "none" },
            //sem depthStencil: o pass não tem depth attachment
        });
    }

    /** O pass assume a posse do cubemap (destroy() o libera junto). */
    setCubemap(texture: GPUTexture): void {
        this.cubemap?.destroy();
        this.cubemap = texture;
        this.cubemapBindGroup = this.device.createBindGroup({
            label: "skybox cubemap",
            layout: this.cubemapLayout,
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: texture.createView({ dimension: "cube" }) },
            ],
        });
    }

    /**
     * Limpa `target` e desenha o cubemap nele. SEMPRE faz o clear, mesmo sem
     * cubemap/câmera/cubo — o mesh pass que vem depois usa loadOp:"load" e
     * conta com este pass ter inicializado o alvo.
     */
    render(
        encoder: GPUCommandEncoder,
        root: Node,
        target: GPUTextureView,
        width: number,
        height: number,
    ): void {
        //acha a câmera (primeira, como no mesh pass) e o renderable de skybox
        let cameraNode: Node | null = null;
        let skybox: Renderable | null = null;
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node;
            }
            if (node.renderable && node.renderable.passMask & RenderPassBit.Skybox && !skybox) {
                if (node.renderable.meshType === MeshType.Static) {
                    skybox = node.renderable;
                } else {
                    console.warn("SkyboxRenderPass: a mesh do skybox precisa ser Static — pulando.");
                }
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        const pass = encoder.beginRenderPass({
            label: "skybox pass",
            timestampWrites: gpuTimer.timestampWrites("skybox"),
            colorAttachments: [
                {
                    view: target,
                    loadOp: "clear",
                    clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue
                    storeOp: "store",
                },
            ],
        });

        if (skybox && cameraNode && this.cubemapBindGroup) {
            const cam = cameraNode as Node;
            cam.camera!.aspect = width / height;
            const view = mat4.invert(cam.worldMatrix); //invert não muta a fonte
            this.frameData.set(view, 0);
            this.frameData.set(cam.camera!.getProjectionMatrix(), 16);
            this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);

            const mesh = (skybox as Renderable).mesh;
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.frameBindGroup);
            pass.setBindGroup(1, this.cubemapBindGroup);
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            pass.drawIndexed(mesh.indexCount);
        }
        pass.end();
    }

    /** Libera os recursos de GPU do pass (uniform e o cubemap, se dono). */
    destroy(): void {
        this.frameBuffer.destroy();
        this.cubemap?.destroy();
        this.cubemap = null;
        this.cubemapBindGroup = null;
    }
}
