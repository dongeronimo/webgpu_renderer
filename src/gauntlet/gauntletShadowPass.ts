//GauntletShadowPass: desenha os shadow maps de spot/directional — 1 render
//depth-only POR LUZ VISÍVEL (é o "provavelmente vai ter que ser um shadow
//pass por luz" já esperado: cada luz enxerga um pedaço diferente da cena,
//então cada uma precisa da sua PRÓPRIA travessia+cull+buffer de objeto).
//Point light ainda não lança sombra (cubemap fica pra próxima rodada).
//
//Pipelines mínimos, sem fragment shader (WebGPU aceita — é um pass só de
//depth): o grupo 1 aqui é ENXUTO comparado ao main pass (só a model matrix,
//sem normalMatrix — sombra não lê normal). O pool de poses é idêntico ao do
//skinned pass, mas é OUTRO buffer, por luz.
//
//Importante sobre correção: cada luz tem seu PRÓPRIO conjunto de buffers
//(frame + objeto estático + objeto skinnado), nunca reaproveitados entre
//luzes no mesmo frame. device.queue.writeBuffer() não é sincronizado com a
//ordem de gravação do encoder — reescrever UM buffer compartilhado várias
//vezes antes do único submit() do frame faria TODOS os draws lerem o
//ÚLTIMO valor escrito, não o valor de quando cada um foi gravado. Por isso
//"slot por luz" (ver ShadowSlot) em vez de um buffer só reciclado no loop.
import { mat4, type Mat4 } from "wgpu-matrix";
import { Node } from "../node";
import { gpuTimer } from "../gpuTimer";
import { RenderPassBit } from "../renderable";
import type { Mesh } from "../mesh";
import { StaticMesh, SkinnedMesh } from "../mesh";
import type { Skin } from "../skin";
import { FrustumCuller } from "../frustumCuller";
import { GauntletLighting, SHADOW_DEPTH_FORMAT } from "./gauntletLighting";

const FLOATS_PER_MAT4 = 16;
const FLOATS_PER_STATIC_OBJECT = FLOATS_PER_MAT4; //só model — sombra não lê normal
//Pool de poses em matrizes (blocos de tamanho variável, um por objeto
//skinnado — ver gauntletSkinnedRenderPass). Por LUZ, então começa modesto.
const INITIAL_POOL_MATRICES = 128;
//Tabela de offsets, em INSTÂNCIAS.
const INITIAL_INSTANCES = 32;

//O frustum da luz costuma enquadrar menos coisa que o da câmera (cone de
//spot, ou a caixa do directional já fitada na cena) — margem menor que a
//dos passes de câmera (4) é suficiente.
const SHADOW_CULL_MARGIN = 2;

const STATIC_SHADOW_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;
@vertex
fn vs(@location(0) position: vec3f, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
    return frame.viewProj * models[instance] * vec4f(position, 1.0);
}
`;

//Pool PLANO de poses (blocos de tamanho variável, um por esqueleto) + tabela
//de bases por instância — mesmo esquema, e mesmo motivo, do
//gauntletSkinnedRenderPass: é o que deixa o draw ser INSTANCIADO.
const SKINNED_SHADOW_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> poses: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> boneOffsets: array<u32>;
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
    @builtin(instance_index) instance: u32,
) -> @builtin(position) vec4f {
    let base = boneOffsets[instance];
    let m =
        poses[base + joints.x] * weights.x +
        poses[base + joints.y] * weights.y +
        poses[base + joints.z] * weights.z +
        poses[base + joints.w] * weights.w;
    return frame.viewProj * m * vec4f(position, 1.0);
}
`;

interface StaticShadowItem {
    mesh: Mesh;
    world: Mat4;
}
interface SkinnedShadowItem {
    mesh: Mesh;
    skin: Skin;
    /** Base do bloco deste objeto no pool de poses; vai no firstInstance. */
    boneOffset: number;
}

//Recursos de UMA luz (spot[i] ou directional[i]). Nunca compartilhado entre
//luzes — ver o comentário do topo do arquivo.
interface ShadowSlot {
    frameBuffer: GPUBuffer;
    frameBindGroup: GPUBindGroup;
    frameData: Float32Array<ArrayBuffer>;
    staticCapacity: number;
    staticBuffer: GPUBuffer;
    staticBindGroup: GPUBindGroup;
    staticData: Float32Array<ArrayBuffer>;
    /** Capacidade do pool de poses em MATRIZES, não em objetos. */
    poseCapacity: number;
    skinnedBuffer: GPUBuffer;
    skinnedData: Float32Array<ArrayBuffer>;
    /** Base do bloco de cada instância no pool; capacidade em INSTÂNCIAS. */
    instanceCapacity: number;
    offsetBuffer: GPUBuffer;
    offsetData: Uint32Array<ArrayBuffer>;
    skinnedBindGroup: GPUBindGroup;
}

export class GauntletShadowPass {
    private readonly device: GPUDevice;
    private readonly frameBindGroupLayout: GPUBindGroupLayout;
    private readonly staticObjectBindGroupLayout: GPUBindGroupLayout;
    private readonly skinnedObjectBindGroupLayout: GPUBindGroupLayout;
    private readonly staticPipeline: GPURenderPipeline;
    private readonly skinnedPipeline: GPURenderPipeline;
    //Reaproveitado a cada luz — update() sobrescreve os planos, sem alocar.
    private readonly cullScratch = new FrustumCuller();

    //Um slot por índice de luz visível; cresce (nunca encolhe) conforme o
    //Nº de spots/directionals visíveis cresce ao longo da sessão.
    private readonly spotSlots: ShadowSlot[] = [];
    private readonly dirSlots: ShadowSlot[] = [];

    constructor(device: GPUDevice) {
        this.device = device;

        this.frameBindGroupLayout = device.createBindGroupLayout({
            label: "gauntlet shadow frame (grupo 0)",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });
        this.staticObjectBindGroupLayout = device.createBindGroupLayout({
            label: "gauntlet shadow objeto estático (grupo 1)",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
        });
        this.skinnedObjectBindGroupLayout = device.createBindGroupLayout({
            label: "gauntlet shadow objeto skinnado (grupo 1)",
            entries: [
                //0 = poses (pool de mat4), 1 = base do bloco por instância
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });

        const staticModule = device.createShaderModule({ label: "gauntlet shadow static", code: STATIC_SHADOW_WGSL });
        this.staticPipeline = device.createRenderPipeline({
            label: "gauntlet shadow static",
            layout: device.createPipelineLayout({
                label: "gauntlet shadow static pipeline layout",
                bindGroupLayouts: [this.frameBindGroupLayout, this.staticObjectBindGroupLayout],
            }),
            vertex: { module: staticModule, entryPoint: "vs", buffers: [StaticMesh.vertexLayout] },
            //sem fragment: pass só-de-depth, não precisa rasterizar cor
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: SHADOW_DEPTH_FORMAT,
                depthWriteEnabled: true,
                depthCompare: "less",
                //bias fixo pra evitar shadow acne sem precisar de bias manual
                //no fragment shader do main (que só faz a comparação).
                depthBias: 2,
                depthBiasSlopeScale: 2,
            },
        });

        const skinnedModule = device.createShaderModule({ label: "gauntlet shadow skinned", code: SKINNED_SHADOW_WGSL });
        this.skinnedPipeline = device.createRenderPipeline({
            label: "gauntlet shadow skinned",
            layout: device.createPipelineLayout({
                label: "gauntlet shadow skinned pipeline layout",
                bindGroupLayouts: [this.frameBindGroupLayout, this.skinnedObjectBindGroupLayout],
            }),
            vertex: { module: skinnedModule, entryPoint: "vs", buffers: [SkinnedMesh.vertexLayout] },
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: SHADOW_DEPTH_FORMAT,
                depthWriteEnabled: true,
                depthCompare: "less",
                depthBias: 2,
                depthBiasSlopeScale: 2,
            },
        });
    }

    /** Chamar depois de lighting.updateFrame() e antes de mainPass/skinnedPass. */
    render(encoder: GPUCommandEncoder, root: Node, lighting: GauntletLighting): void {
        //1 label por LUZ (não 1 agregado): é assim que o custo por luz fica
        //visível na telinha de desempenho — a tabela cresce com o Nº de
        //luzes de propósito, é o preço de medir cada shadow pass à parte.
        lighting.spotShadowViewProj.forEach((viewProj, i) => {
            this.renderOneMap(encoder, root, viewProj, lighting.getSpotShadowLayerView(i), this.getSlot(this.spotSlots, i), `shadow spot ${i}`);
        });
        lighting.directionalShadowViewProj.forEach((viewProj, i) => {
            this.renderOneMap(encoder, root, viewProj, lighting.getDirectionalShadowLayerView(i), this.getSlot(this.dirSlots, i), `shadow dir ${i}`);
        });
    }

    private renderOneMap(
        encoder: GPUCommandEncoder,
        root: Node,
        viewProj: Mat4,
        depthView: GPUTextureView,
        slot: ShadowSlot,
        label: string,
    ): void {
        this.cullScratch.update(viewProj);

        const staticItems: StaticShadowItem[] = [];
        const skinnedItems: SkinnedShadowItem[] = [];
        const collect = (node: Node) => {
            if (node.renderable) {
                const aabb = node.renderable.worldAABB(node.worldMatrix);
                if (this.cullScratch.intersectsAABB(aabb.min, aabb.max, SHADOW_CULL_MARGIN)) {
                    if (node.renderable.passMask & RenderPassBit.Main) {
                        staticItems.push({ mesh: node.renderable.mesh, world: node.worldMatrix });
                    } else if (node.renderable.passMask & RenderPassBit.Skinned && node.skin) {
                        skinnedItems.push({ mesh: node.renderable.mesh, skin: node.skin, boneOffset: 0 });
                    }
                }
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        //Agrupa por MESH (só existe 1 pipeline por família aqui e nenhum
        //material, então a mesh é a chave inteira do batch) — instancing só
        //junta itens VIZINHOS, e a travessia da cena não entrega os iguais
        //lado a lado. A ordem final tem que sair ANTES da escrita nos
        //buffers: o índice do item na lista é o instance_index dele.
        const meshIds = new Map<Mesh, number>();
        for (const item of staticItems) {
            if (!meshIds.has(item.mesh)) meshIds.set(item.mesh, meshIds.size);
        }
        for (const item of skinnedItems) {
            if (!meshIds.has(item.mesh)) meshIds.set(item.mesh, meshIds.size);
        }
        staticItems.sort((a, b) => meshIds.get(a.mesh)! - meshIds.get(b.mesh)!);
        skinnedItems.sort((a, b) => meshIds.get(a.mesh)! - meshIds.get(b.mesh)!);

        //Prefix-sum dos jointCount: cada objeto ganha um bloco do tamanho
        //exato do seu esqueleto.
        let totalBones = 0;
        for (const item of skinnedItems) {
            item.boneOffset = totalBones;
            totalBones += item.skin.jointCount;
        }

        //---- envio: 1 write por buffer, todos ANTES do render pass deste
        //slot — a leitura na GPU acontece no submit() do frame, então isto
        //só precisa estar certo relativo aos OUTROS writes deste MESMO slot,
        //nunca em relação aos de outra luz (slots são independentes).
        slot.frameData.set(viewProj, 0);
        this.device.queue.writeBuffer(slot.frameBuffer, 0, slot.frameData);

        if (staticItems.length > slot.staticCapacity) {
            this.growStaticSlot(slot, staticItems.length);
        }
        staticItems.forEach((item, i) => slot.staticData.set(item.world, i * FLOATS_PER_STATIC_OBJECT));
        if (staticItems.length) {
            this.device.queue.writeBuffer(slot.staticBuffer, 0, slot.staticData, 0, staticItems.length * FLOATS_PER_STATIC_OBJECT);
        }

        if (totalBones > slot.poseCapacity) {
            this.growSkinnedSlot(slot, totalBones);
            this.rebuildSkinnedBindGroup(slot);
        }
        if (skinnedItems.length > slot.instanceCapacity) {
            this.growOffsetSlot(slot, skinnedItems.length);
            this.rebuildSkinnedBindGroup(slot);
        }
        skinnedItems.forEach((item, i) => {
            slot.offsetData[i] = item.boneOffset;
            this.writeSkinPoseOnly(item.skin, slot.skinnedData, item.boneOffset);
        });
        if (skinnedItems.length) {
            this.device.queue.writeBuffer(slot.skinnedBuffer, 0, slot.skinnedData, 0, totalBones * FLOATS_PER_MAT4);
            this.device.queue.writeBuffer(slot.offsetBuffer, 0, slot.offsetData, 0, skinnedItems.length);
        }

        //---- draw ----
        const pass = encoder.beginRenderPass({
            label: `gauntlet shadow map (${label})`,
            timestampWrites: gpuTimer.timestampWrites(label),
            colorAttachments: [],
            depthStencilAttachment: {
                view: depthView,
                depthLoadOp: "clear",
                depthClearValue: 1.0,
                depthStoreOp: "store",
            },
        });
        pass.setBindGroup(0, slot.frameBindGroup);

        if (staticItems.length) {
            pass.setPipeline(this.staticPipeline);
            pass.setBindGroup(1, slot.staticBindGroup);
            //INSTANCED por mesh: 1 slot de model matrix por objeto, escrito na
            //ordem da lista → os slots de um trecho são consecutivos e
            //instance_index cai no slot certo, sem buffer extra. É aqui que a
            //dungeon inteira (centenas de paredes iguais) deixa de custar
            //centenas de draws POR LUZ.
            let start = 0;
            while (start < staticItems.length) {
                const mesh = staticItems[start].mesh;
                let end = start + 1;
                while (end < staticItems.length && staticItems[end].mesh === mesh) {
                    end++;
                }
                pass.setVertexBuffer(0, mesh.vertexBuffer);
                pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
                pass.drawIndexed(mesh.indexCount, end - start, 0, 0, start);
                start = end;
            }
        }
        if (skinnedItems.length) {
            pass.setPipeline(this.skinnedPipeline);
            pass.setBindGroup(1, slot.skinnedBindGroup);
            //INSTANCED: um draw por trecho contíguo de mesma mesh; cada
            //instância acha o esqueleto dela por boneOffsets[instance_index].
            let start = 0;
            while (start < skinnedItems.length) {
                const mesh = skinnedItems[start].mesh;
                let end = start + 1;
                while (end < skinnedItems.length && skinnedItems[end].mesh === mesh) {
                    end++;
                }
                pass.setVertexBuffer(0, mesh.vertexBuffer);
                pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
                pass.drawIndexed(mesh.indexCount, end - start, 0, 0, start);
                start = end;
            }
        }
        pass.end();
    }

    //pose = boneWorld · inverseBind, igual ao skinnedRenderPass — o bloco tem
    //exatamente jointCount matrizes, a partir de `boneOffset`.
    private writeSkinPoseOnly(skin: Skin, data: Float32Array, boneOffset: number): void {
        const base = boneOffset * FLOATS_PER_MAT4;
        for (let j = 0; j < skin.jointCount; j++) {
            const off = base + j * FLOATS_PER_MAT4;
            mat4.multiply(skin.bones[j].worldMatrix, skin.inverseBind(j), data.subarray(off, off + FLOATS_PER_MAT4));
        }
    }

    private getSlot(slots: ShadowSlot[], i: number): ShadowSlot {
        while (slots.length <= i) {
            slots.push(this.createSlot());
        }
        return slots[i];
    }

    private createSlot(): ShadowSlot {
        const frameBuffer = this.device.createBuffer({
            label: "gauntlet shadow frame",
            size: FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const frameBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow frame",
            layout: this.frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
        });

        const staticCapacity = 32;
        const staticBuffer = this.device.createBuffer({
            label: "gauntlet shadow static objects",
            size: staticCapacity * FLOATS_PER_STATIC_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const staticBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow static objects",
            layout: this.staticObjectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: staticBuffer } }],
        });

        const poseCapacity = INITIAL_POOL_MATRICES;
        const skinnedBuffer = this.device.createBuffer({
            label: "gauntlet shadow skinned objects",
            size: poseCapacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const instanceCapacity = INITIAL_INSTANCES;
        const offsetBuffer = this.device.createBuffer({
            label: "gauntlet shadow bone offsets",
            size: instanceCapacity * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const skinnedBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow skinned objects",
            layout: this.skinnedObjectBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: skinnedBuffer } },
                { binding: 1, resource: { buffer: offsetBuffer } },
            ],
        });

        return {
            frameBuffer, frameBindGroup,
            frameData: new Float32Array(FLOATS_PER_MAT4),
            staticCapacity, staticBuffer, staticBindGroup,
            staticData: new Float32Array(staticCapacity * FLOATS_PER_STATIC_OBJECT),
            poseCapacity, skinnedBuffer,
            skinnedData: new Float32Array(poseCapacity * FLOATS_PER_MAT4),
            instanceCapacity, offsetBuffer,
            offsetData: new Uint32Array(instanceCapacity),
            skinnedBindGroup,
        };
    }

    private growStaticSlot(slot: ShadowSlot, minCount: number): void {
        let capacity = Math.max(slot.staticCapacity, 32);
        while (capacity < minCount) capacity *= 2;
        slot.staticBuffer.destroy();
        slot.staticCapacity = capacity;
        slot.staticData = new Float32Array(capacity * FLOATS_PER_STATIC_OBJECT);
        slot.staticBuffer = this.device.createBuffer({
            label: "gauntlet shadow static objects",
            size: capacity * FLOATS_PER_STATIC_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        slot.staticBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow static objects",
            layout: this.staticObjectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: slot.staticBuffer } }],
        });
    }

    /** `minMatrices` é contado em MATRIZES do pool, não em objetos. */
    private growSkinnedSlot(slot: ShadowSlot, minMatrices: number): void {
        let capacity = Math.max(slot.poseCapacity, INITIAL_POOL_MATRICES);
        while (capacity < minMatrices) capacity *= 2;
        slot.skinnedBuffer.destroy();
        slot.poseCapacity = capacity;
        slot.skinnedData = new Float32Array(capacity * FLOATS_PER_MAT4);
        slot.skinnedBuffer = this.device.createBuffer({
            label: "gauntlet shadow skinned objects",
            size: capacity * FLOATS_PER_MAT4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    /** `minInstances` é contado em INSTÂNCIAS (itens), não em matrizes. */
    private growOffsetSlot(slot: ShadowSlot, minInstances: number): void {
        let capacity = Math.max(slot.instanceCapacity, INITIAL_INSTANCES);
        while (capacity < minInstances) capacity *= 2;
        slot.offsetBuffer.destroy();
        slot.instanceCapacity = capacity;
        slot.offsetData = new Uint32Array(capacity);
        slot.offsetBuffer = this.device.createBuffer({
            label: "gauntlet shadow bone offsets",
            size: capacity * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    //Os dois buffers dividem o mesmo bind group: recriar um obriga a refazê-lo.
    private rebuildSkinnedBindGroup(slot: ShadowSlot): void {
        slot.skinnedBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow skinned objects",
            layout: this.skinnedObjectBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: slot.skinnedBuffer } },
                { binding: 1, resource: { buffer: slot.offsetBuffer } },
            ],
        });
    }

    destroy(): void {
        for (const slot of [...this.spotSlots, ...this.dirSlots]) {
            slot.frameBuffer.destroy();
            slot.staticBuffer.destroy();
            slot.skinnedBuffer.destroy();
            slot.offsetBuffer.destroy();
        }
    }
}
