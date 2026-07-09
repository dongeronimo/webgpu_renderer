//Pass de meshes: desenha os renderables do mundo num alvo próprio
//(cor + depth). Quem põe esse resultado na tela é o FinalRenderPass.
//
//Donos, seguindo a divisão combinada:
//  grupo 0 (frame)  — uniform com view e proj da câmera, separadas
//                     (sombra/iluminação vão precisar delas individualmente).
//                     Dono: este pass.
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
import { gpuTimer } from "./gpuTimer";
import { Node } from "./node";
import type { Renderable } from "./renderable";
import { RenderPassBit } from "./renderable";
import {
    Material,
    UnshadedOpaque,
    BIND_GROUP_FRAME,
    BIND_GROUP_OBJECT,
    BIND_GROUP_MATERIAL,
    type PipelineContext,
} from "./material";

/** Formato do depth deste pass — exportado pra quem compartilha o alvo. */
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
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

    //grupo 0: view (64 bytes) + proj (64 bytes), no layout do struct Frame
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(2 * FLOATS_PER_MAT4);

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
    private _depthView: GPUTextureView | null = null;

    //Renderable sem material atribuído desenha com este magenta berrante:
    //melhor um "esqueci o material" gritando que um objeto invisível.
    private readonly fallbackMaterial: UnshadedOpaque;

    //"load" quando outro pass (ex.: skybox) já pintou o alvo antes deste;
    //"clear" (default) quando este pass é o primeiro a tocar o alvo.
    private readonly colorLoadOp: GPULoadOp;

    //"store" quando outro pass roda DEPOIS deste testando contra o depth
    //dos opacos (ex.: fatias translúcidas); "discard" (default) quando
    //ninguém lê o depth depois do pass.
    private readonly depthStoreOp: GPUStoreOp;

    constructor(
        device: GPUDevice,
        colorFormat: GPUTextureFormat,
        colorLoadOp: GPULoadOp = "clear",
        depthStoreOp: GPUStoreOp = "discard",
    ) {
        this.device = device;
        this.colorLoadOp = colorLoadOp;
        this.depthStoreOp = depthStoreOp;

        //VERTEX | FRAGMENT: a mesh opaca só lê frame/objeto no vertex, mas um
        //material de raymarch (VolumeRaycast) precisa deles no FRAGMENT — a
        //view pra reconstruir a câmera e a model pra levar o raio ao espaço
        //local da caixa. Alargar a visibilidade é superset benigno (quem só
        //usa no vertex continua válido); é o mesmo que o TransparentSlices
        //RenderPass já faz nos layouts dele.
        const frameBindGroupLayout = device.createBindGroupLayout({
            label: "mesh pass frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "mesh pass objeto (grupo 1)",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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
            label: "mesh pass frame (view + proj)",
            size: this.frameData.byteLength,
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

    /**
     * O depth dos opacos, pra um pass posterior testar oclusão contra ele.
     * Só tem conteúdo válido se o pass foi construído com depthStoreOp
     * "store" — com "discard" o que está aqui é lixo.
     */
    get depthView(): GPUTextureView {
        if (!this._depthView) {
            throw new Error("MeshRenderPass.depthView lido antes de ensureTargets().");
        }
        return this._depthView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number): void {
        this.ensureTargets(width, height);

        //---- 1. agrupamento ----
        const items: DrawItem[] = [];
        let cameraNode: Node | null = null;
        //Só lê o cache de worldMatrix, que o World.update deste frame já
        //preencheu (o main chama update antes do render) — aqui não se
        //calcula matriz nenhuma.
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node; //primeira câmera achada é A câmera
            }
            //só desenha quem aceita o main pass — o cubo do skybox, por
            //exemplo, vive na árvore mas não tem esse bit
            if (node.renderable && node.renderable.passMask & RenderPassBit.Main) {
                const material = node.renderable.material ?? this.fallbackMaterial;
                items.push({
                    renderable: node.renderable,
                    material,
                    pipeline: material.getPipeline(this.ctx, node.renderable.meshType),
                    world: node.worldMatrix,
                });
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

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
            const view = mat4.invert(cam.worldMatrix); //invert não muta a fonte
            this.frameData.set(view, 0);
            this.frameData.set(cam.camera!.getProjectionMatrix(), FLOATS_PER_MAT4);
            this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
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
            timestampWrites: gpuTimer.timestampWrites("mesh"),
            colorAttachments: [
                {
                    view: this._colorView!,
                    loadOp: this.colorLoadOp,
                    clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this._depthView!,
                depthLoadOp: "clear",
                depthClearValue: 1.0, //fundo = o mais longe possível
                depthStoreOp: this.depthStoreOp,
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

    /** Libera os recursos de GPU do pass (buffers, alvos, material fallback). */
    destroy(): void {
        this.frameBuffer.destroy();
        this.objectBuffer.destroy();
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = null;
        this.depthTexture = null;
        this._colorView = null;
        this._depthView = null;
        this.fallbackMaterial.destroy();
    }

    /**
     * Garante os alvos no tamanho pedido (recria só quando muda). Pública
     * porque um pass que roda ANTES deste no mesmo alvo (ex.: skybox)
     * precisa do colorView já existindo — o mundo chama isto primeiro.
     */
    ensureTargets(width: number, height: number): void {
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
        this._depthView = this.depthTexture.createView();
    }
}
