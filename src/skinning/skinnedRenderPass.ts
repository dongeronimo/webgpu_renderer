//SkinnedRenderPass: o pass das meshes skinnadas. É irmão do MainRenderPass —
//mesma ideia (frame + objeto + material, draw ordenado por pipeline/material),
//mas o grupo 1 é DIFERENTE: em vez de uma model matrix por objeto, é um bloco
//de matrizes de OSSO por objeto.
//
//Por objeto reservamos MAX_BONES (100) slots de PODE e MAX_BONES de boneModel:
//  pose[j]      = boneWorld_j · inverseBind_j  (a matriz de skinning; no bind
//                 pose vira identidade). É o que o vértice usa.
//  boneModel[j] = boneWorld_j                  (model matrix crua do osso;
//                 disponível pra attachments/debug, não usada no LBS básico).
//O ID de junta do vértice indexa direto esses arrays (id == slot) — é o que
//torna a reserva fixa e generosa (200 mat4/objeto = 12.8 KB) o preço de uma
//indexação sem tabela de remapeamento.
//
//Como o buffer de instâncias (as matrizes) vive AQUI no pass, a skin precisa
//do seu próprio pass — uma mesh skinnada não cabe no grupo de objeto do main.
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import type { Renderable } from "../renderable";
import { RenderPassBit } from "../renderable";
import type { Skin } from "../skin";
import { MAX_BONES } from "../skin";
import {
    Material,
    BIND_GROUP_FRAME,
    BIND_GROUP_OBJECT,
    BIND_GROUP_MATERIAL,
    type PipelineContext,
} from "../material";
import { SkinnedPhongMaterial } from "./SkinnedPhongMaterial";

/** Formato do depth deste pass — exportado pra quem compartilha o alvo. */
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const FLOATS_PER_MAT4 = 16;
//Por objeto: MAX_BONES matrizes de pose + MAX_BONES de boneModel.
const FLOATS_PER_OBJECT = 2 * MAX_BONES * FLOATS_PER_MAT4;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    skin: Skin;
}

export class SkinnedRenderPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;

    //grupo 0: view (64) + proj (64) + cameraPos (vec4) + light0Pos (vec4)
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(2 * FLOATS_PER_MAT4 + 4 + 4);

    //grupo 1: o bufferzão de matrizes de osso, um bloco por objeto. Cresce
    //quando o mundo cresce; o conteúdo é reescrito todo frame.
    private objectCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectBindGroup!: GPUBindGroup;
    private objectData!: Float32Array<ArrayBuffer>;

    //Alvos de render, recriados quando o tamanho do canvas muda.
    private colorTexture: GPUTexture | null = null;
    private depthTexture: GPUTexture | null = null;
    private _colorView: GPUTextureView | null = null;
    private _depthView: GPUTextureView | null = null;

    //Skinnado sem material desenha neste magenta berrante (mesmo do main pass,
    //mas na variante skinnada — o fallback tem que casar com o grupo 1 daqui).
    private readonly fallbackMaterial: SkinnedPhongMaterial;

    private readonly colorLoadOp: GPULoadOp;
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

        const frameBindGroupLayout = device.createBindGroupLayout({
            label: "skinned pass frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "skinned pass objeto (grupo 1)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
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
            label: "skinned pass frame",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "skinned pass frame",
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });

        //Poucos objetos skinnados por cena, e cada um é pesado (12.8 KB) —
        //começa pequeno e dobra sob demanda.
        this.growObjectBuffer(8);
        this.fallbackMaterial = new SkinnedPhongMaterial(this.device, [1, 0, 1, 1]);
    }

    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("SkinnedRenderPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    get depthView(): GPUTextureView {
        if (!this._depthView) {
            throw new Error("SkinnedRenderPass.depthView lido antes de ensureTargets().");
        }
        return this._depthView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number): void {
        this.ensureTargets(width, height);

        //---- 1. agrupamento ----
        const items: DrawItem[] = [];
        let cameraNode: Node | null = null;
        let lightNode: Node | null = null;
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node;
            }
            if (node.light && !lightNode) {
                lightNode = node;
            }
            //só entra quem aceita o pass de skinning E tem esqueleto: sem skin
            //não há matrizes de osso pra alimentar o shader.
            if (node.renderable && node.renderable.passMask & RenderPassBit.Skinned && node.skin) {
                const material = node.renderable.material ?? this.fallbackMaterial;
                items.push({
                    renderable: node.renderable,
                    material,
                    pipeline: material.getPipeline(this.ctx, node.renderable.meshType),
                    skin: node.skin,
                });
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        //Ordena por pipeline e depois por material (chave estável = ordem de
        //primeira aparição), pra trocar estado o mínimo no draw.
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
            cam.camera!.aspect = width / height;
            const view = mat4.invert(cam.worldMatrix);
            this.frameData.set(view, 0);
            this.frameData.set(cam.camera!.getProjectionMatrix(), FLOATS_PER_MAT4);
            this.frameData.set(cam.position, 2 * FLOATS_PER_MAT4); //cameraPos (vec4, w ignorado)
            if (lightNode) {
                //light0Pos é DIREÇÃO no shader skinnado — a "posição" do nó de
                //luz vira o vetor da luz. Sem luz, fica no que já estava (0).
                this.frameData.set((lightNode as Node).position, 2 * FLOATS_PER_MAT4 + 4);
            }
            this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
        } else if (items.length > 0) {
            console.warn("SkinnedRenderPass: nenhum nó com camera no mundo — nada será desenhado.");
            items.length = 0;
        }

        if (items.length > this.objectCapacity) {
            this.growObjectBuffer(items.length);
        }
        items.forEach((item, i) => {
            this.writeSkin(item.skin, i);
        });
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer,
                0,
                this.objectData,
                0,
                items.length * FLOATS_PER_OBJECT,
            );
        }

        //---- 3. draw, na mesma ordem do envio ----
        const pass = encoder.beginRenderPass({
            label: "skinned pass",
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
                depthClearValue: 1.0,
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
            //firstInstance = i → o shader lê objects[i], o bloco deste draw
            pass.drawIndexed(mesh.indexCount, 1, 0, 0, i);
        });
        pass.end();
    }

    //Preenche o bloco do objeto `i`: por osso, pose = boneWorld · inverseBind
    //e boneModel = boneWorld. Slots além do jointCount ficam com o que estava
    //(lixo zerado ou de um objeto anterior) — inofensivo, já que só juntas
    //com peso > 0 são lidas, e essas estão todas dentro do jointCount.
    private writeSkin(skin: Skin, i: number): void {
        const poseBase = i * FLOATS_PER_OBJECT;
        const modelBase = poseBase + MAX_BONES * FLOATS_PER_MAT4;
        const n = Math.min(skin.jointCount, MAX_BONES);
        for (let j = 0; j < n; j++) {
            //worldMatrix é o cache que o World.update deste frame já fechou.
            const boneWorld = skin.bones[j].worldMatrix;
            const off = j * FLOATS_PER_MAT4;
            this.objectData.set(boneWorld, modelBase + off);
            //pose escrita direto no destino via subarray (sem alocar Mat4).
            mat4.multiply(
                boneWorld,
                skin.inverseBind(j),
                this.objectData.subarray(poseBase + off, poseBase + off + FLOATS_PER_MAT4),
            );
        }
    }

    private growObjectBuffer(minObjects: number): void {
        let capacity = Math.max(this.objectCapacity, 8);
        while (capacity < minObjects) {
            capacity *= 2;
        }
        this.objectBuffer?.destroy();
        this.objectCapacity = capacity;
        this.objectData = new Float32Array(capacity * FLOATS_PER_OBJECT);
        this.objectBuffer = this.device.createBuffer({
            label: "skinned pass bone matrices",
            size: capacity * FLOATS_PER_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "skinned pass objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
        });
    }

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

    ensureTargets(width: number, height: number): void {
        if (this.colorTexture && this.colorTexture.width === width && this.colorTexture.height === height) {
            return;
        }
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = this.device.createTexture({
            label: "skinned pass color",
            size: [width, height],
            format: this.ctx.colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "skinned pass depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this._depthView = this.depthTexture.createView();
    }
}
