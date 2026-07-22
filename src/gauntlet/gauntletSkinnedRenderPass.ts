//GauntletSkinnedRenderPass: fork do SkinnedRenderPass (skinning/skinnedRenderPass.ts)
//pra suportar múltiplas luzes. Mesma ideia do GauntletMainRenderPass: o
//grupo 0 (frame + luzes) não é mais deste pass — é da GauntletLighting
//compartilhada, atualizada UMA vez por frame pelo GauntletWorld antes de
//mainPass/skinnedPass rodarem. Ver gauntletLighting.ts.
//
//Grupo 1 continua sendo o bloco de matrizes de OSSO por objeto (ver o
//cabeçalho do arquivo original) — completamente ortogonal a este trabalho.
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
import { GauntletLighting } from "./gauntletLighting";
import { SkinnedPhongMaterial } from "./materials/SkinnedPhongMaterial";

/** Formato do depth deste pass — exportado pra quem compartilha o alvo. */
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
//Culling é responsabilidade do pass: frustum via AABB de mundo, com margem
//de segurança. Aqui a AABB é a do BIND POSE (mesh.boundsMin/Max local,
//transformado pelo worldMatrix do pivot) — não acompanha o membro balançando
//na animação, então a margem também cobre essa folga, não só a borda da
//tela. Cada objeto skinnado é 2*MAX_BONES mat4 (12.8 KB) — é o que mais
//cresce mal com centenas de mobs, então é o que mais compensa cullar cedo.
const FRUSTUM_CULL_MARGIN = 4;
const FLOATS_PER_MAT4 = 16;
//Por objeto: MAX_BONES matrizes de pose + MAX_BONES de boneModel.
const FLOATS_PER_OBJECT = 2 * MAX_BONES * FLOATS_PER_MAT4;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    skin: Skin;
}

export class GauntletSkinnedRenderPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;
    private readonly lighting: GauntletLighting;

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

    //Skinnado sem material desenha neste magenta berrante. Tem que ser o
    //fork EXCLUSIVO do Gauntlet (não skinning/SkinnedPhongMaterial) pelo
    //mesmo motivo do fallback do GauntletMainRenderPass — ver gauntletLighting.ts.
    private readonly fallbackMaterial: SkinnedPhongMaterial;

    private readonly colorLoadOp: GPULoadOp;
    private readonly depthStoreOp: GPUStoreOp;

    constructor(
        device: GPUDevice,
        lighting: GauntletLighting,
        colorFormat: GPUTextureFormat,
        colorLoadOp: GPULoadOp = "clear",
        depthStoreOp: GPUStoreOp = "discard",
    ) {
        this.device = device;
        this.lighting = lighting;
        this.colorLoadOp = colorLoadOp;
        this.depthStoreOp = depthStoreOp;

        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "gauntlet skinned pass objeto (grupo 1)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });
        this.ctx = {
            device,
            colorFormat,
            depthFormat: DEPTH_FORMAT,
            frameBindGroupLayout: lighting.frameBindGroupLayout,
            objectBindGroupLayout,
        };

        //Poucos objetos skinnados por cena, e cada um é pesado (12.8 KB) —
        //começa pequeno e dobra sob demanda.
        this.growObjectBuffer(8);
        this.fallbackMaterial = new SkinnedPhongMaterial(this.device, [1, 0, 1, 1]);
    }

    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("GauntletSkinnedRenderPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    get depthView(): GPUTextureView {
        if (!this._depthView) {
            throw new Error("GauntletSkinnedRenderPass.depthView lido antes de ensureTargets().");
        }
        return this._depthView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number): void {
        this.ensureTargets(width, height);
        this.draw(encoder, root, this._colorView!, this._depthView!, this.colorLoadOp, "clear");
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
    ): void {
        this.draw(encoder, root, colorView, depthView, "load", "load");
    }

    private draw(
        encoder: GPUCommandEncoder,
        root: Node,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        colorLoadOp: GPULoadOp,
        depthLoadOp: GPULoadOp,
    ): void {
        //---- 1. agrupamento ----
        const items: DrawItem[] = [];
        const collect = (node: Node) => {
            //só entra quem aceita o pass de skinning E tem esqueleto: sem skin
            //não há matrizes de osso pra alimentar o shader.
            if (node.renderable && node.renderable.passMask & RenderPassBit.Skinned && node.skin) {
                //Cull ANTES de entrar em items: fora do frustum (+ margem) nem
                //pega pipeline/material, nem ocupa o bloco de 2*MAX_BONES
                //matrizes no buffer de objeto.
                const aabb = node.renderable.worldAABB(node.worldMatrix);
                if (this.lighting.frustum.intersectsAABB(aabb.min, aabb.max, FRUSTUM_CULL_MARGIN)) {
                    const material = node.renderable.material ?? this.fallbackMaterial;
                    items.push({
                        renderable: node.renderable,
                        material,
                        pipeline: material.getPipeline(this.ctx, node.renderable.meshType),
                        skin: node.skin,
                    });
                }
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
        //Frame (view/proj/cameraPos/luzes) já foi escrito pela GauntletLighting
        //ANTES deste draw() — aqui só cuidamos do grupo 1 (matrizes de osso).
        if (!this.lighting.hasCamera && items.length > 0) {
            console.warn("GauntletSkinnedRenderPass: nenhum nó com camera no mundo — nada será desenhado.");
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
            label: "gauntlet skinned pass",
            //"mesh" já é o label do GauntletMainRenderPass (dungeon) — os dois
            //rodam no MESMO frame no Gauntlet, e gpuTimer.passEma é um Map
            //keyed por label (ver gpuTimer.ts): duas queries com o mesmo label
            //no mesmo frame não só duplicam a key do GpuStats (React warning),
            //elas se MISTURAM no mesmo slot do Map — os tempos de dungeon e de
            //skinning ficavam ilegíveis, somados um em cima do outro.
            timestampWrites: gpuTimer.timestampWrites("skinnedMesh"),
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
        pass.setBindGroup(BIND_GROUP_FRAME, this.lighting.frameBindGroup);
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
            label: "gauntlet skinned pass bone matrices",
            size: capacity * FLOATS_PER_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "gauntlet skinned pass objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
        });
    }

    destroy(): void {
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
            label: "gauntlet skinned pass color",
            size: [width, height],
            format: this.ctx.colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "gauntlet skinned pass depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this._depthView = this.depthTexture.createView();
    }
}
