//SHADOW MAP do sol — o primeiro shadow pass do engine. Depth-only: renderiza
//a cena do ponto de vista da luz (projeção ORTOGRÁFICA, luz direcional) e
//guarda só a profundidade. Quem consome decide sombra por comparação: um
//ponto está na sombra se algo ficou MAIS PERTO da luz que ele (depth do mapa
//< depth do ponto em light-space).
//
//É deliberadamente um irmão simplificado do MainRenderPass: mesma coleta da
//árvore (bit Main = todo opaco projeta sombra; o proxy do volume tem bit
//Volume e fica de fora — a sombra da fumaça vem da transmitância, não daqui),
//mesmo storage buffer de model matrices indexado por firstInstance. Sem
//fragment shader (pipeline sem color target), sem materiais, sem sort — o
//pipeline é um só.
//
//Contra shadow acne: depthBias constante + slope-scaled no PIPELINE (aplicado
//quando o mapa é ESCRITO, vale pra todos os leitores) + um bias pequeno no
//shader de quem lê. cullMode "back" (não o truque de "front"): a cena tem
//lajes finas (SmokeBlocker) que vazariam luz com front-culling.
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import { RenderPassBit } from "../renderable";
import type { Mat4 } from "wgpu-matrix";
import { StaticMesh } from "../mesh";

export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_DEPTH_FORMAT: GPUTextureFormat = "depth32float";

const FLOATS_PER_MAT4 = 16;

const SHADOW_WGSL = /* wgsl */ `
struct U {
    lightViewProj: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;

@vertex
fn vs(@location(0) position: vec3f, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
    return u.lightViewProj * models[instance] * vec4f(position, 1.0);
}
`;

export class SunShadowPass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;

    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(FLOATS_PER_MAT4);

    //Model matrices dos casters, mesmo padrão de crescimento do MainRenderPass
    //(só a model — sombra não precisa de normal matrix).
    private readonly objectLayout: GPUBindGroupLayout;
    private objectCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectBindGroup!: GPUBindGroup;
    private modelData!: Float32Array<ArrayBuffer>;

    private readonly depthTexture: GPUTexture;
    readonly depthView: GPUTextureView;

    constructor(device: GPUDevice) {
        this.device = device;

        const frameLayout = device.createBindGroupLayout({
            label: "sun shadow frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ],
        });
        this.objectLayout = device.createBindGroupLayout({
            label: "sun shadow objeto (grupo 1)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });

        const module = device.createShaderModule({ label: "sun shadow shader", code: SHADOW_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "sun shadow pipeline",
            layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.objectLayout] }),
            vertex: { module, entryPoint: "vs", buffers: [StaticMesh.vertexLayout] },
            //SEM fragment: pipeline sem color target só escreve depth — é o
            //jeito canônico (e mais barato) de shadow pass.
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: SHADOW_DEPTH_FORMAT,
                depthWriteEnabled: true,
                depthCompare: "less",
                //Anti-acne na escrita: empurra o depth gravado "pra longe" um
                //tiquinho, proporcional à inclinação da face vista da luz.
                depthBias: 2,
                depthBiasSlopeScale: 3.0,
            },
        });

        this.frameBuffer = device.createBuffer({
            label: "sun shadow lightViewProj",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "sun shadow frame",
            layout: frameLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });
        this.growObjectBuffer(64);

        //Tamanho fixo: o shadow map não segue o canvas (resolução de sombra é
        //um knob independente da resolução de tela). View estável → quem faz
        //bind group com ela nunca precisa recriar.
        this.depthTexture = device.createTexture({
            label: "sun shadow map",
            size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
            format: SHADOW_DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthView = this.depthTexture.createView();
    }

    /** Renderiza os casters (bit Main) no shadow map com o viewProj do sol. */
    render(encoder: GPUCommandEncoder, root: Node, lightViewProj: Mat4): void {
        //Coleta: todo renderable do main pass projeta sombra. O worldMatrix é
        //o cache preenchido pelo World.update deste frame, como nos outros passes.
        const items: { node: Node }[] = [];
        const collect = (node: Node) => {
            if (node.renderable && node.renderable.passMask & RenderPassBit.Main) {
                items.push({ node });
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        this.frameData.set(lightViewProj, 0);
        this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);

        if (items.length > this.objectCapacity) {
            this.growObjectBuffer(items.length);
        }
        items.forEach((item, i) => this.modelData.set(item.node.worldMatrix, i * FLOATS_PER_MAT4));
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer, 0, this.modelData, 0, items.length * FLOATS_PER_MAT4,
            );
        }

        const pass = encoder.beginRenderPass({
            label: "sun shadow pass",
            timestampWrites: gpuTimer.timestampWrites("shadow"),
            colorAttachments: [],
            depthStencilAttachment: {
                view: this.depthView,
                depthLoadOp: "clear",
                depthClearValue: 1.0,
                depthStoreOp: "store",
            },
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.frameBindGroup);
        pass.setBindGroup(1, this.objectBindGroup);
        items.forEach((item, i) => {
            const mesh = item.node.renderable!.mesh;
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            pass.drawIndexed(mesh.indexCount, 1, 0, 0, i); //firstInstance = slot no storage
        });
        pass.end();
    }

    private growObjectBuffer(minObjects: number): void {
        let capacity = Math.max(this.objectCapacity, 64);
        while (capacity < minObjects) {
            capacity *= 2;
        }
        this.objectBuffer?.destroy();
        this.objectCapacity = capacity;
        this.modelData = new Float32Array(capacity * FLOATS_PER_MAT4);
        this.objectBuffer = this.device.createBuffer({
            label: "sun shadow model matrices",
            size: capacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "sun shadow objeto",
            layout: this.objectLayout,
            entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
        });
    }

    destroy(): void {
        this.frameBuffer.destroy();
        this.objectBuffer.destroy();
        this.depthTexture.destroy();
    }
}
