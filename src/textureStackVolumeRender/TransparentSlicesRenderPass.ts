//Pass das fatias translúcidas (VR clássico por pilha de meshes): desenha
//os renderables com o bit TransparentSlices num alvo próprio e deixa o
//BLEND DE HARDWARE compor fatia sobre fatia. O blend NÃO é estado do pass
//— mora no fragment.targets[0].blend do pipeline, ou seja, no TIPO de
//material (junto com depthWriteEnabled: false). O pass só controla
//attachments e load/store.
//
//A DIFERENÇA DELIBERADA pro MeshRenderPass: aqui NÃO HÁ SORT. Com blend,
//a ordem de draw é semântica — cada fatia compõe sobre as anteriores —
//então o contrato é: DRAW NA ORDEM DE TRAVESSIA DA ÁRVORE (pai antes dos
//filhos, filhos na ordem do array children). Quem garante back-to-front é
//o dono do nó-pilha (ex.: uma behaviour que reordena children quando a
//câmera cruza o plano da pilha). O invariante "ordem no buffer == ordem
//de draw" do bufferzão continua valendo — só que a ordem agora vem da
//árvore, não de um sort.
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
import { mat4, type Mat4 } from "wgpu-matrix";
import { Node } from "../node";
import type { Renderable } from "../renderable";
import { RenderPassBit } from "../renderable";
import { DEPTH_FORMAT } from "../meshPass";
import {
    Material,
    UnshadedOpaque,
    BIND_GROUP_FRAME,
    BIND_GROUP_OBJECT,
    BIND_GROUP_MATERIAL,
    type PipelineContext,
} from "../material";

const FLOATS_PER_MAT4 = 16;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    world: Mat4;
}

export class TransparentSlicesRenderPass {
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
    private depthView: GPUTextureView | null = null;

    //Renderable sem material atribuído desenha com este magenta berrante:
    //melhor um "esqueci o material" gritando que um objeto invisível.
    private readonly fallbackMaterial: UnshadedOpaque;

    //"load" quando outro pass (ex.: skybox) já pintou o alvo antes deste;
    //"clear" (default) quando este pass é o primeiro a tocar o alvo.
    private readonly colorLoadOp: GPULoadOp;

    constructor(device: GPUDevice, colorFormat: GPUTextureFormat, colorLoadOp: GPULoadOp = "clear") {
        this.device = device;
        this.colorLoadOp = colorLoadOp;

        const frameBindGroupLayout = device.createBindGroupLayout({
            label: "transparent slices frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ],
        });
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "transparent slices objeto (grupo 1)",
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
            label: "transparent slices frame (view + proj)",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "transparent slices frame",
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });

        this.growObjectBuffer(64);
        this.fallbackMaterial = new UnshadedOpaque(device, [1, 0, 1, 1]);
    }

    /** A textura de cor com o resultado do pass — o que o final pass compõe. */
    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("TransparentSlicesRenderPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number): void {
        this.ensureTargets(width, height);

        //---- 1. coleta — SEM sort, a ordem da árvore É a ordem de draw ----
        const items: DrawItem[] = [];
        let cameraNode: Node | null = null;
        //Só lê o cache de worldMatrix, que o World.update deste frame já
        //preencheu (o main chama update antes do render) — aqui não se
        //calcula matriz nenhuma.
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node; //primeira câmera achada é A câmera
            }
            //só desenha quem aceita este pass — objetos comuns (bit Main)
            //vivem na mesma árvore mas não entram aqui
            if (node.renderable && node.renderable.passMask & RenderPassBit.TransparentSlices) {
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

        //Aqui NÃO se ordena por pipeline/material como no MeshRenderPass:
        //aquilo é otimização de troca de estado, e com blend a ordem é
        //corretude. Reordenar os children do nó-pilha reordena os draws.

        //---- 2. envio ----
        if (cameraNode) {
            const cam = cameraNode as Node;
            cam.camera!.aspect = width / height; //segue o canvas automaticamente
            const view = mat4.invert(cam.worldMatrix); //invert não muta a fonte
            this.frameData.set(view, 0);
            this.frameData.set(cam.camera!.getProjectionMatrix(), FLOATS_PER_MAT4);
            this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
        } else if (items.length > 0) {
            console.warn("TransparentSlicesRenderPass: nenhum nó com camera no mundo — nada será desenhado.");
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
            label: "transparent slices pass",
            colorAttachments: [
                {
                    view: this._colorView!,
                    loadOp: this.colorLoadOp,
                    clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue
                    storeOp: "store",
                },
            ],
            //O depth existe pra honrar o contrato do PipelineContext (todo
            //pipeline de material declara depth24plus). As fatias testam
            //contra ele mas NÃO escrevem (depthWriteEnabled: false no
            //material), então num mundo só de fatias ele fica no clear.
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
            label: "transparent slices model matrices",
            size: capacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "transparent slices objeto",
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
        this.depthView = null;
        this.fallbackMaterial.destroy();
    }

    /**
     * Garante os alvos no tamanho pedido (recria só quando muda). Pública
     * pra manter a simetria com o MeshRenderPass, caso um pass venha a
     * rodar antes deste no mesmo alvo.
     */
    ensureTargets(width: number, height: number): void {
        if (this.colorTexture && this.colorTexture.width === width && this.colorTexture.height === height) {
            return;
        }
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = this.device.createTexture({
            label: "transparent slices color",
            size: [width, height],
            format: this.ctx.colorFormat,
            //RENDER_ATTACHMENT pra desenhar aqui, TEXTURE_BINDING pro
            //final pass poder ler na composição
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "transparent slices depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this.depthView = this.depthTexture.createView();
    }
}
