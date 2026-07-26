//GauntletSkinnedRenderPass: fork do SkinnedRenderPass (skinning/skinnedRenderPass.ts)
//pra suportar múltiplas luzes. Mesma ideia do GauntletMainRenderPass: o
//grupo 0 (frame + luzes) não é mais deste pass — é da GauntletLighting
//compartilhada, atualizada UMA vez por frame pelo GauntletWorld antes de
//mainPass/skinnedPass rodarem. Ver gauntletLighting.ts.
//
//Grupo 1 continua sendo as matrizes de OSSO (ver o cabeçalho do arquivo
//original) — completamente ortogonal ao trabalho de iluminação.
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
import { GauntletLighting } from "./gauntletLighting";
import { SkinnedPhongMaterial } from "./materials/SkinnedPhongMaterial";

/** Formato do depth deste pass — exportado pra quem compartilha o alvo. */
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
//Culling é responsabilidade do pass: frustum via AABB de mundo, com margem
//de segurança. Aqui a AABB é a do BIND POSE (mesh.boundsMin/Max local,
//transformado pelo worldMatrix do pivot) — não acompanha o membro balançando
//na animação, então a margem também cobre essa folga, não só a borda da
//tela. Cullar cedo poupa o bloco de matrizes do objeto no pool.
const FRUSTUM_CULL_MARGIN = 4;
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
    /**
     * Índice, no pool plano, da primeira matriz deste objeto. NÃO vai no draw:
     * vai na tabela `boneOffsets[]`, que o shader lê por instance_index.
     * Preenchido depois da ordenação, pra que a escrita no pool siga a mesma
     * ordem dos draws.
     */
    boneOffset: number;
}

export class GauntletSkinnedRenderPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;
    private readonly lighting: GauntletLighting;

    //grupo 1, binding 0: pool PLANO de matrizes de pose (array<mat4x4f>, sem
    //struct). Cada objeto ocupa exatamente skin.jointCount matrizes, uma atrás
    //da outra. Cresce quando a cena cresce; reescrito todo frame.
    private boneCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectData!: Float32Array<ArrayBuffer>;

    //grupo 1, binding 1: por INSTÂNCIA, onde começa o bloco dela no pool.
    //É o que permite INSTANCING de verdade: num draw instanciado o
    //instance_index anda de 1 em 1, então ele não pode ser a base do bloco (os
    //blocos têm tamanhos diferentes) — ele indexa ESTA tabela, que diz a base.
    private instanceCapacity = 0;
    private offsetBuffer!: GPUBuffer;
    private offsetData!: Uint32Array<ArrayBuffer>;

    private objectBindGroup!: GPUBindGroup;

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
                //0 = poses (pool de mat4), 1 = base do bloco por instância
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });
        this.ctx = {
            device,
            colorFormat,
            depthFormat: DEPTH_FORMAT,
            frameBindGroupLayout: lighting.frameBindGroupLayout,
            objectBindGroupLayout,
        };

        this.growPoseBuffer(INITIAL_POOL_MATRICES);
        this.growOffsetBuffer(INITIAL_INSTANCES);
        this.rebuildObjectBindGroup();
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
                //pega pipeline/material, nem ocupa matrizes no pool.
                const aabb = node.renderable.worldAABB(node.worldMatrix);
                if (this.lighting.frustum.intersectsAABB(aabb.min, aabb.max, FRUSTUM_CULL_MARGIN)) {
                    const material = node.renderable.material ?? this.fallbackMaterial;
                    items.push({
                        renderable: node.renderable,
                        material,
                        pipeline: material.getPipeline(this.ctx, node.renderable.meshType),
                        skin: node.skin,
                        boneOffset: 0, //atribuído depois da ordenação
                    });
                }
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        //Ordena por pipeline, material e MESH (chave estável = ordem de
        //primeira aparição). Os dois primeiros critérios são pra trocar estado
        //o mínimo; a mesh entrou pro INSTANCING: só objetos vizinhos na lista
        //viram um draw só, então "mesmo (pipeline, material, mesh)" precisa
        //ser um trecho CONTÍGUO, não espalhado.
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
        //Frame (view/proj/cameraPos/luzes) já foi escrito pela GauntletLighting
        //ANTES deste draw() — aqui só cuidamos do grupo 1 (matrizes de osso).
        if (!this.lighting.hasCamera && items.length > 0) {
            console.warn("GauntletSkinnedRenderPass: nenhum nó com camera no mundo — nada será desenhado.");
            items.length = 0;
        }

        //Blocos de tamanho VARIÁVEL: a base de cada objeto é a soma dos
        //jointCount de todos os anteriores (prefix-sum). Feito depois do sort
        //pra que a ordem de escrita no pool seja a mesma dos draws — e, com
        //instancing, pra que o índice do item seja o instance_index dele.
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

        //INSTANCED: varre a lista ordenada em trechos que compartilham
        //(pipeline, material, mesh) e emite UM draw por trecho. N cópias do
        //mesmo prefab (que dividem mesh e material por referência — ver
        //prefab.ts) viram 1 draw call com N instâncias, cada uma com seu
        //esqueleto próprio via boneOffsets[instance_index].
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
            //start..end-1, que é exatamente a faixa deles em boneOffsets[].
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
            label: "gauntlet skinned pass bone matrices",
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
            label: "gauntlet skinned pass bone offsets",
            size: capacity * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    //Os dois buffers moram no MESMO bind group, então recriar qualquer um dos
    //dois obriga a refazê-lo (o bind group guarda o GPUBuffer, não uma
    //indireção que se atualize sozinha).
    private rebuildObjectBindGroup(): void {
        this.objectBindGroup = this.device.createBindGroup({
            label: "gauntlet skinned pass objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.objectBuffer } },
                { binding: 1, resource: { buffer: this.offsetBuffer } },
            ],
        });
    }

    destroy(): void {
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
