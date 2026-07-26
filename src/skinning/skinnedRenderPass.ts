//SkinnedRenderPass: o pass das meshes skinnadas. É irmão do MainRenderPass —
//mesma ideia (frame + objeto + material, draw ordenado por pipeline/material),
//mas o grupo 1 é DIFERENTE: em vez de uma model matrix por objeto, é um bloco
//de matrizes de OSSO por objeto.
//
//O grupo 1 tem DUAS peças:
//  binding 0 `poses`       — POOL PLANO de matrizes de skinning
//                            (pose[j] = boneWorld_j · inverseBind_j; no bind
//                            pose vira identidade). Cada objeto ocupa
//                            exatamente `skin.jointCount` matrizes, um bloco
//                            atrás do outro (prefix-sum na CPU).
//  binding 1 `boneOffsets` — por INSTÂNCIA, onde o bloco dela começa.
//O shader faz `poses[boneOffsets[instance_index] + jointId]`. A indireção
//existe porque os blocos têm TAMANHOS DIFERENTES: num draw instanciado o
//instance_index anda de 1 em 1, então ele não pode ser a base do bloco.
//Com isso o pass INSTANCIA de verdade — N cópias do mesmo prefab (mesma mesh,
//mesmo material, esqueletos próprios) saem em 1 draw call. O ID de junta
//continua indexando direto (id == slot dentro do bloco), e uma grama de 5
//ossos custa 5 matrizes, não as 200 do teto antigo.
//
//Como o buffer de instâncias (as matrizes) vive AQUI no pass, a skin precisa
//do seu próprio pass — uma mesh skinnada não cabe no grupo de objeto do main.
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import type { Mesh } from "../mesh";
import type { Renderable } from "../renderable";
import { RenderPassBit } from "../renderable";
import type { Skin } from "../skin";
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
//Capacidade inicial do pool, em MATRIZES (não em objetos): ~4 esqueletos de
//personagem. Dobra sob demanda.
const INITIAL_POOL_MATRICES = 256;
//Capacidade inicial da tabela de offsets, em INSTÂNCIAS.
const INITIAL_INSTANCES = 64;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    skin: Skin;
    /** Base do bloco deste objeto no pool; vai na tabela boneOffsets[]. */
    boneOffset: number;
}

export class SkinnedRenderPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;

    //grupo 0: view (64) + proj (64) + cameraPos (vec4) + light0Pos (vec4)
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(2 * FLOATS_PER_MAT4 + 4 + 4);

    //grupo 1, binding 0: pool plano de matrizes de osso, um bloco de tamanho
    //variável por objeto. Cresce quando a cena cresce; reescrito todo frame.
    private boneCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectData!: Float32Array<ArrayBuffer>;

    //grupo 1, binding 1: onde começa o bloco de cada INSTÂNCIA no pool. Sem
    //isto não dá pra instanciar: instance_index anda de 1 em 1 e os blocos
    //não têm todos o mesmo tamanho.
    private instanceCapacity = 0;
    private offsetBuffer!: GPUBuffer;
    private offsetData!: Uint32Array<ArrayBuffer>;

    private objectBindGroup!: GPUBindGroup;

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
                //0 = poses (pool de mat4), 1 = base do bloco por instância
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
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

        this.growPoseBuffer(INITIAL_POOL_MATRICES);
        this.growOffsetBuffer(INITIAL_INSTANCES);
        this.rebuildObjectBindGroup();
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
        this.draw(encoder, root, this._colorView!, this._depthView!, width, height, this.colorLoadOp, "clear");
    }

    /**
     * Desenha no alvo de OUTRO pass (ex.: o mainPass do dungeon) em vez da
     * textura própria — color E depth em "load": respeita o que já foi
     * desenhado (senão o chão/paredes, se vierem depois, cobririam os
     * avatares) e testa profundidade contra a geometria não-skinnada já
     * presente. Os formatos batem (ambos depth24plus) — ver DEPTH_FORMAT.
     */
    renderOnto(
        encoder: GPUCommandEncoder,
        root: Node,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        width: number,
        height: number,
    ): void {
        this.draw(encoder, root, colorView, depthView, width, height, "load", "load");
    }

    private draw(
        encoder: GPUCommandEncoder,
        root: Node,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        width: number,
        height: number,
        colorLoadOp: GPULoadOp,
        depthLoadOp: GPULoadOp,
    ): void {
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
                    boneOffset: 0, //atribuído depois da ordenação
                });
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        //Ordena por pipeline, material e MESH (chave estável = ordem de
        //primeira aparição): os dois primeiros pra trocar estado o mínimo, a
        //mesh pro instancing (só itens VIZINHOS viram um draw só).
        const pipelineIds = new Map<GPURenderPipeline, number>();
        const materialIds = new Map<Material, number>();
        const meshIds = new Map<Mesh, number>();
        for (const item of items) {
            if (!pipelineIds.has(item.pipeline)) pipelineIds.set(item.pipeline, pipelineIds.size);
            if (!materialIds.has(item.material)) materialIds.set(item.material, materialIds.size);
            if (!meshIds.has(item.renderable.mesh)) meshIds.set(item.renderable.mesh, meshIds.size);
        }
        items.sort(
            (a, b) =>
                pipelineIds.get(a.pipeline)! - pipelineIds.get(b.pipeline)! ||
                materialIds.get(a.material)! - materialIds.get(b.material)! ||
                meshIds.get(a.renderable.mesh)! - meshIds.get(b.renderable.mesh)!,
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

        //Blocos de tamanho VARIÁVEL: a base de cada objeto é a soma dos
        //jointCount dos anteriores (prefix-sum), na ordem já ordenada — a
        //mesma em que os draws saem.
        let totalBones = 0;
        for (const item of items) {
            item.boneOffset = totalBones;
            totalBones += item.skin.jointCount;
        }
        if (totalBones > this.boneCapacity) {
            this.growPoseBuffer(totalBones);
            this.rebuildObjectBindGroup();
        }
        if (items.length > this.instanceCapacity) {
            this.growOffsetBuffer(items.length);
            this.rebuildObjectBindGroup();
        }
        items.forEach((item, i) => {
            this.offsetData[i] = item.boneOffset;
            this.writeSkin(item.skin, item.boneOffset);
        });
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer,
                0,
                this.objectData,
                0,
                totalBones * FLOATS_PER_MAT4,
            );
            this.device.queue.writeBuffer(this.offsetBuffer, 0, this.offsetData, 0, items.length);
        }

        //---- 3. draw, na mesma ordem do envio ----
        const pass = encoder.beginRenderPass({
            label: "skinned pass",
            timestampWrites: gpuTimer.timestampWrites("mesh"),
            colorAttachments: [
                {
                    view: colorView,
                    loadOp: colorLoadOp,
                    clearValue: { r: 0.39, g: 0.58, b: 0.93, a: 1 }, //cornflower blue
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depthView,
                depthLoadOp,
                depthClearValue: 1.0,
                depthStoreOp: this.depthStoreOp,
            },
        });
        pass.setBindGroup(BIND_GROUP_FRAME, this.frameBindGroup);
        pass.setBindGroup(BIND_GROUP_OBJECT, this.objectBindGroup);

        //INSTANCED: um draw por trecho contíguo de mesmo (pipeline, material,
        //mesh) — ver o cabeçalho do arquivo.
        let lastPipeline: GPURenderPipeline | null = null;
        let lastMaterial: Material | null = null;
        let start = 0;
        while (start < items.length) {
            const first = items[start];
            const mesh = first.renderable.mesh;
            let end = start + 1;
            while (
                end < items.length &&
                items[end].pipeline === first.pipeline &&
                items[end].material === first.material &&
                items[end].renderable.mesh === mesh
            ) {
                end++;
            }
            if (first.pipeline !== lastPipeline) {
                pass.setPipeline(first.pipeline);
                lastPipeline = first.pipeline;
            }
            if (first.material !== lastMaterial) {
                pass.setBindGroup(BIND_GROUP_MATERIAL, first.material.getBindGroup());
                lastMaterial = first.material;
            }
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            //firstInstance = índice do 1º item do trecho → instance_index anda
            //start..end-1, a faixa deles em boneOffsets[].
            pass.drawIndexed(mesh.indexCount, end - start, 0, 0, start);
            start = end;
        }
        pass.end();
    }

    //Preenche o bloco deste objeto, `skin.jointCount` matrizes a partir de
    //`boneOffset`: pose[j] = boneWorld_j · inverseBind_j. Escreve só o que o
    //bloco cobre — o que vem depois pertence ao PRÓXIMO objeto.
    private writeSkin(skin: Skin, boneOffset: number): void {
        const base = boneOffset * FLOATS_PER_MAT4;
        for (let j = 0; j < skin.jointCount; j++) {
            //worldMatrix é o cache que o World.update deste frame já fechou.
            const off = base + j * FLOATS_PER_MAT4;
            //pose escrita direto no destino via subarray (sem alocar Mat4).
            mat4.multiply(
                skin.bones[j].worldMatrix,
                skin.inverseBind(j),
                this.objectData.subarray(off, off + FLOATS_PER_MAT4),
            );
        }
    }

    /** `minMatrices` é contado em MATRIZES do pool, não em objetos. */
    private growPoseBuffer(minMatrices: number): void {
        let capacity = Math.max(this.boneCapacity, INITIAL_POOL_MATRICES);
        while (capacity < minMatrices) {
            capacity *= 2;
        }
        this.objectBuffer?.destroy();
        this.boneCapacity = capacity;
        this.objectData = new Float32Array(capacity * FLOATS_PER_MAT4);
        this.objectBuffer = this.device.createBuffer({
            label: "skinned pass bone matrices",
            size: capacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private growOffsetBuffer(minInstances: number): void {
        let capacity = Math.max(this.instanceCapacity, INITIAL_INSTANCES);
        while (capacity < minInstances) {
            capacity *= 2;
        }
        this.offsetBuffer?.destroy();
        this.instanceCapacity = capacity;
        this.offsetData = new Uint32Array(capacity);
        this.offsetBuffer = this.device.createBuffer({
            label: "skinned pass bone offsets",
            size: capacity * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    //Os dois buffers moram no mesmo bind group: recriar um obriga a refazê-lo.
    private rebuildObjectBindGroup(): void {
        this.objectBindGroup = this.device.createBindGroup({
            label: "skinned pass objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.objectBuffer } },
                { binding: 1, resource: { buffer: this.offsetBuffer } },
            ],
        });
    }

    destroy(): void {
        this.frameBuffer.destroy();
        this.objectBuffer.destroy();
        this.offsetBuffer.destroy();
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
