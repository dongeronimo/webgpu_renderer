//GauntletShadowPass: desenha os shadow maps de spot/directional — 1 render
//depth-only POR LUZ VISÍVEL (é o "provavelmente vai ter que ser um shadow
//pass por luz" já esperado: cada luz enxerga um pedaço diferente da cena,
//então cada uma precisa da sua PRÓPRIA travessia+cull+buffer de objeto).
//Point light ainda não lança sombra (cubemap fica pra próxima rodada).
//
//Pipelines mínimos, sem fragment shader (WebGPU aceita — é um pass só de
//depth): o grupo 1 aqui é ENXUTO comparado ao main/skinned pass (só a model
//matrix, sem normalMatrix; só pose[], sem boneModel — sombra não lê normal).
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
import { MAX_BONES } from "../skin";
import { FrustumCuller } from "../frustumCuller";
import { GauntletLighting, SHADOW_DEPTH_FORMAT } from "./gauntletLighting";

const FLOATS_PER_MAT4 = 16;
const FLOATS_PER_STATIC_OBJECT = FLOATS_PER_MAT4; //só model — sombra não lê normal
const FLOATS_PER_SKINNED_OBJECT = MAX_BONES * FLOATS_PER_MAT4; //só pose[] — sem boneModel

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

const SKINNED_SHADOW_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f };
struct SkinObject { pose: array<mat4x4f, ${MAX_BONES}> };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> objects: array<SkinObject>;
@vertex
fn vs(
    @location(0) position: vec3f,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4f,
    @builtin(instance_index) instance: u32,
) -> @builtin(position) vec4f {
    let m =
        objects[instance].pose[joints.x] * weights.x +
        objects[instance].pose[joints.y] * weights.y +
        objects[instance].pose[joints.z] * weights.z +
        objects[instance].pose[joints.w] * weights.w;
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
    skinnedCapacity: number;
    skinnedBuffer: GPUBuffer;
    skinnedBindGroup: GPUBindGroup;
    skinnedData: Float32Array<ArrayBuffer>;
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
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
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
                        skinnedItems.push({ mesh: node.renderable.mesh, skin: node.skin });
                    }
                }
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

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

        if (skinnedItems.length > slot.skinnedCapacity) {
            this.growSkinnedSlot(slot, skinnedItems.length);
        }
        skinnedItems.forEach((item, i) => this.writeSkinPoseOnly(item.skin, slot.skinnedData, i));
        if (skinnedItems.length) {
            this.device.queue.writeBuffer(slot.skinnedBuffer, 0, slot.skinnedData, 0, skinnedItems.length * FLOATS_PER_SKINNED_OBJECT);
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
            staticItems.forEach((item, i) => {
                pass.setVertexBuffer(0, item.mesh.vertexBuffer);
                pass.setIndexBuffer(item.mesh.indexBuffer, item.mesh.indexFormat);
                pass.drawIndexed(item.mesh.indexCount, 1, 0, 0, i);
            });
        }
        if (skinnedItems.length) {
            pass.setPipeline(this.skinnedPipeline);
            pass.setBindGroup(1, slot.skinnedBindGroup);
            skinnedItems.forEach((item, i) => {
                pass.setVertexBuffer(0, item.mesh.vertexBuffer);
                pass.setIndexBuffer(item.mesh.indexBuffer, item.mesh.indexFormat);
                pass.drawIndexed(item.mesh.indexCount, 1, 0, 0, i);
            });
        }
        pass.end();
    }

    //pose = boneWorld · inverseBind, igual ao skinnedRenderPass — só que sem
    //gravar boneModel (a sombra não lê normal, então não precisa dele).
    private writeSkinPoseOnly(skin: Skin, data: Float32Array, i: number): void {
        const base = i * FLOATS_PER_SKINNED_OBJECT;
        const n = Math.min(skin.jointCount, MAX_BONES);
        for (let j = 0; j < n; j++) {
            const boneWorld = skin.bones[j].worldMatrix;
            const off = j * FLOATS_PER_MAT4;
            mat4.multiply(boneWorld, skin.inverseBind(j), data.subarray(base + off, base + off + FLOATS_PER_MAT4));
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

        const skinnedCapacity = 4;
        const skinnedBuffer = this.device.createBuffer({
            label: "gauntlet shadow skinned objects",
            size: skinnedCapacity * FLOATS_PER_SKINNED_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const skinnedBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow skinned objects",
            layout: this.skinnedObjectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: skinnedBuffer } }],
        });

        return {
            frameBuffer, frameBindGroup,
            frameData: new Float32Array(FLOATS_PER_MAT4),
            staticCapacity, staticBuffer, staticBindGroup,
            staticData: new Float32Array(staticCapacity * FLOATS_PER_STATIC_OBJECT),
            skinnedCapacity, skinnedBuffer, skinnedBindGroup,
            skinnedData: new Float32Array(skinnedCapacity * FLOATS_PER_SKINNED_OBJECT),
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

    private growSkinnedSlot(slot: ShadowSlot, minCount: number): void {
        let capacity = Math.max(slot.skinnedCapacity, 4);
        while (capacity < minCount) capacity *= 2;
        slot.skinnedBuffer.destroy();
        slot.skinnedCapacity = capacity;
        slot.skinnedData = new Float32Array(capacity * FLOATS_PER_SKINNED_OBJECT);
        slot.skinnedBuffer = this.device.createBuffer({
            label: "gauntlet shadow skinned objects",
            size: capacity * FLOATS_PER_SKINNED_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        slot.skinnedBindGroup = this.device.createBindGroup({
            label: "gauntlet shadow skinned objects",
            layout: this.skinnedObjectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: slot.skinnedBuffer } }],
        });
    }

    destroy(): void {
        for (const slot of [...this.spotSlots, ...this.dirSlots]) {
            slot.frameBuffer.destroy();
            slot.staticBuffer.destroy();
            slot.skinnedBuffer.destroy();
        }
    }
}
