//Pass de meshes: desenha os renderables do mundo num alvo próprio
//(cor + depth). Quem põe esse resultado na tela é o FinalRenderPass.
//
//Donos, seguindo a divisão combinada:
//  grupo 0 (frame)  — uniform com a viewProj da câmera. Dono: este pass.
//  grupo 1 (objeto) — UM storage buffer com todas as model matrices do
//                     frame, uma por slot na ordem de draw; cada draw acha
//                     a sua passando o slot em firstInstance, que chega no
//                     shader como @builtin(instance_index). Dono: este pass.
//  grupo 2 (material) — da instância de Material.
//
//O frame tem três etapas, e é o pass fazer as três que garante o
//invariante "ordem no buffer == ordem de draw":
//  1. agrupamento: coleta (renderable, worldMatrix) da árvore e ordena
//     por pipeline (troca mais cara) e depois por material;
//  2. envio: escreve as matrizes no bufferzão nessa ordem, um writeBuffer;
//  3. draw: itera na mesma ordem, trocando estado só quando muda.
import { mat4, type Mat4 } from "wgpu-matrix";
import { Node } from "./node";
import type { Renderable } from "./renderable";
import {
    Material,
    UnshadedOpaque,
    BIND_GROUP_FRAME,
    BIND_GROUP_OBJECT,
    BIND_GROUP_MATERIAL,
    type PipelineContext,
} from "./material";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const FLOATS_PER_MAT4 = 16;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    world: Mat4;
}

export class MeshRenderPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;

    //grupo 0: viewProj (64 bytes)
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;

    //grupo 1: o bufferzão de model matrices. Cresce quando o mundo cresce
    //(recriar buffer + bind group é barato se for raro); o conteúdo é
    //reescrito todo frame.
    private objectCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectBindGroup!: GPUBindGroup;
    private modelData!: Float32Array<ArrayBuffer>;

    //Alvos de render, recriados quando o tamanho do canvas muda.
    private colorTexture: GPUTexture | null = null;
    private depthTexture: GPUTexture | null = null;
    private _colorView: GPUTextureView | null = null;
    private depthView: GPUTextureView | null = null;

    //Renderable sem material atribuído desenha com este magenta berrante:
    //melhor um "esqueci o material" gritando que um objeto invisível.
    private readonly fallbackMaterial: UnshadedOpaque;

    constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
        this.device = device;

        const frameBindGroupLayout = device.createBindGroupLayout({
            label: "mesh pass frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ],
        });
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "mesh pass objeto (grupo 1)",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });
        this.ctx = {
            device,
            colorFormat,
            depthFormat: DEPTH_FORMAT,
            frameBindGroupLayout,
            objectBindGroupLayout,
        };

        this.frameBuffer = device.createBuffer({
            label: "mesh pass viewProj",
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "mesh pass frame",
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });

        this.growObjectBuffer(64);
        this.fallbackMaterial = new UnshadedOpaque(device, [1, 0, 1, 1]);
    }

    /** A textura de cor com o resultado do pass — o que o final pass compõe. */
    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("MeshRenderPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number): void {
        this.ensureTargets(width, height);

        //---- 1. agrupamento ----
        const items: DrawItem[] = [];
        let cameraNode: Node | null = null;
        //Desce a árvore acumulando a world matrix no caminho (evita o
        //getWorldMatrix por nó, que re-sobe a cadeia de pais toda vez).
        const collect = (node: Node, parentWorld: Mat4 | null) => {
            const world = node.getLocalMatrix();
            if (parentWorld) {
                mat4.multiply(parentWorld, world, world);
            }
            if (node.camera && !cameraNode) {
                cameraNode = node; //primeira câmera achada é A câmera
            }
            if (node.renderable) {
                const material = node.renderable.material ?? this.fallbackMaterial;
                items.push({
                    renderable: node.renderable,
                    material,
                    pipeline: material.getPipeline(this.ctx, node.renderable.meshType),
                    world,
                });
            }
            for (const child of node.children) {
                collect(child, world);
            }
        };
        collect(root, null);

        //Ordena por pipeline e, dentro do pipeline, por material — os ids
        //são só a ordem de primeira aparição, pra ter chave estável.
        const pipelineIds = new Map<GPURenderPipeline, number>();
        const materialIds = new Map<Material, number>();
        for (const item of items) {
            if (!pipelineIds.has(item.pipeline)) pipelineIds.set(item.pipeline, pipelineIds.size);
            if (!materialIds.has(item.material)) materialIds.set(item.material, materialIds.size);
        }
        items.sort(
            (a, b) =>
                pipelineIds.get(a.pipeline)! - pipelineIds.get(b.pipeline)! ||
                materialIds.get(a.material)! - materialIds.get(b.material)!,
        );

        //---- 2. envio ----
        if (cameraNode) {
            const cam = cameraNode as Node;
            cam.camera!.aspect = width / height; //segue o canvas automaticamente
            const view = mat4.invert(cam.getWorldMatrix());
            const viewProj = mat4.multiply(cam.camera!.getProjectionMatrix(), view);
            this.device.queue.writeBuffer(this.frameBuffer, 0, viewProj as Float32Array<ArrayBuffer>);
        } else if (items.length > 0) {
            console.warn("MeshRenderPass: nenhum nó com camera no mundo — nada será desenhado.");
            items.length = 0;
        }

        if (items.length > this.objectCapacity) {
            this.growObjectBuffer(items.length);
        }
        items.forEach((item, i) => {
            this.modelData.set(item.world, i * FLOATS_PER_MAT4);
        });
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer,
                0,
                this.modelData,
                0,
                items.length * FLOATS_PER_MAT4,
            );
        }

        //---- 3. draw, na mesma ordem do envio ----
        const pass = encoder.beginRenderPass({
            label: "mesh pass",
            colorAttachments: [
                {
                    view: this._colorView!,
                    loadOp: "clear",
                    clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthView!,
                depthLoadOp: "clear",
                depthClearValue: 1.0, //fundo = o mais longe possível
                depthStoreOp: "discard", //ninguém lê o depth depois do pass
            },
        });
        pass.setBindGroup(BIND_GROUP_FRAME, this.frameBindGroup);
        pass.setBindGroup(BIND_GROUP_OBJECT, this.objectBindGroup);

        let lastPipeline: GPURenderPipeline | null = null;
        let lastMaterial: Material | null = null;
        items.forEach((item, i) => {
            if (item.pipeline !== lastPipeline) {
                pass.setPipeline(item.pipeline);
                lastPipeline = item.pipeline;
            }
            if (item.material !== lastMaterial) {
                pass.setBindGroup(BIND_GROUP_MATERIAL, item.material.getBindGroup());
                lastMaterial = item.material;
            }
            const mesh = item.renderable.mesh;
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            //firstInstance = i → o shader lê models[i], o slot deste draw
            pass.drawIndexed(mesh.indexCount, 1, 0, 0, i);
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
            label: "mesh pass model matrices",
            size: capacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "mesh pass objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
        });
    }

    private ensureTargets(width: number, height: number): void {
        if (this.colorTexture && this.colorTexture.width === width && this.colorTexture.height === height) {
            return;
        }
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = this.device.createTexture({
            label: "mesh pass color",
            size: [width, height],
            format: this.ctx.colorFormat,
            //RENDER_ATTACHMENT pra desenhar aqui, TEXTURE_BINDING pro
            //final pass poder ler na composição
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "mesh pass depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this.depthView = this.depthTexture.createView();
    }
}
