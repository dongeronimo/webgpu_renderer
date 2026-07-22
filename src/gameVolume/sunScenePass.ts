//Pass de geometria do gameVolume com SOL + SOMBRAS — o irmão do
//MainRenderPass (StarshipDemo) com o grupo 0 (frame) estendido: além de
//view/proj/cameraPos, carrega direção/cor/intensidade do sol, a lightViewProj
//e as TEXTURAS de sombra (shadow map da geometria + transmitância da fumaça,
//com seus samplers). É contra ESTE layout que o SunPhongMaterial cria seu
//pipeline — por isso o clone: mudar o layout do MainRenderPass quebraria os
//pipelines cacheados dos materiais dos outros mundos ([[worlds não
//destrutivos]]: o mundo novo traz seu pass, os antigos ficam intactos).
//
//Diferenças pro MainRenderPass:
//  - Frame: 60 floats (view, proj, cameraPos, sunDir+intensidade, sunColor,
//    lightViewProj) + bindings 1-4 (shadow map, sampler de comparação,
//    transmitância, sampler linear);
//  - a luz NÃO é descoberta na árvore: o mundo calcula o Sun (direção +
//    matrizes) uma vez por frame e passa pro render — todos os passes de
//    sombra enxergam o MESMO sol;
//  - fallback magenta é um SunPhongMaterial (o UnshadedOpaque cacheia
//    pipeline de outro frame layout — usá-lo aqui explodiria).
//
//O restante (coleta por bit Main, sort pipeline→material, storage de model
//matrices por firstInstance, alvos color+depth) é idêntico ao original.
import { mat4, type Mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import type { Renderable } from "../renderable";
import { RenderPassBit } from "../renderable";
import {
    Material,
    BIND_GROUP_FRAME,
    BIND_GROUP_OBJECT,
    BIND_GROUP_MATERIAL,
    type PipelineContext,
} from "../material";
import { SunPhongMaterial } from "./sunPhongMaterial";
import type { Sun } from "./sun";

/** Formato do depth deste pass — o SmokeVolumePass lê este alvo. */
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const FLOATS_PER_MAT4 = 16;
/** Model matrix + inversa transposta (normal matrix) por objeto. */
const FLOATS_PER_OBJECT = 2 * FLOATS_PER_MAT4;
//view + proj + cameraPos + sunDir/intensidade + sunColor + lightViewProj
const FRAME_FLOATS = 2 * FLOATS_PER_MAT4 + 4 + 4 + 4 + FLOATS_PER_MAT4;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    world: Mat4;
}

export class SunScenePass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;

    private readonly frameBuffer: GPUBuffer;
    private readonly frameData = new Float32Array(FRAME_FLOATS);
    //O bind group do frame inclui shadow map + transmitância, que só chegam
    //no render() — criado lá na primeira vez (e recriado se as views mudarem).
    private frameBindGroup: GPUBindGroup | null = null;
    private lastShadowView: GPUTextureView | null = null;
    private lastSmokeTView: GPUTextureView | null = null;

    private readonly shadowSampler: GPUSampler;
    private readonly smokeTSampler: GPUSampler;

    private objectCapacity = 0;
    private objectBuffer!: GPUBuffer;
    private objectBindGroup!: GPUBindGroup;
    private modelData!: Float32Array<ArrayBuffer>;

    private colorTexture: GPUTexture | null = null;
    private depthTexture: GPUTexture | null = null;
    private _colorView: GPUTextureView | null = null;
    private _depthView: GPUTextureView | null = null;

    //Renderable sem material desenha magenta berrante — mas com um
    //SunPhongMaterial (o pipeline dele casa com o frame layout DESTE pass).
    private readonly fallbackMaterial: SunPhongMaterial;

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
            label: "sun scene frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" } },
                //shadow map do sol (comparação por hardware no PCF)
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "depth", viewDimension: "2d" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: "comparison" } },
                //transmitância da fumaça (float filtrável)
                { binding: 3, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float", viewDimension: "2d" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "sun scene objeto (grupo 1)",
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

        //Sampler de comparação: o hardware compara depth de referência vs
        //texel e já devolve 0/1 (com filtragem = PCF de borda). "less" casa
        //com o depthCompare do shadow pass.
        this.shadowSampler = device.createSampler({
            label: "sun shadow comparison sampler",
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
        });
        this.smokeTSampler = device.createSampler({
            label: "smoke transmittance sampler (scene)",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        this.frameBuffer = device.createBuffer({
            label: "sun scene frame",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.growObjectBuffer(64);
        this.fallbackMaterial = new SunPhongMaterial(device, [1, 0, 1, 1], [0.5, 0, 0.5], 32);
    }

    /** A textura de cor com o resultado do pass — o que o final pass compõe. */
    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("sunScenePass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    /** O depth dos opacos, pro SmokeVolumePass ocluir a fumaça. Válido com depthStoreOp "store". */
    get depthView(): GPUTextureView {
        if (!this._depthView) {
            throw new Error("sunScenePass.depthView lido antes de ensureTargets().");
        }
        return this._depthView;
    }

    render(
        encoder: GPUCommandEncoder,
        root: Node,
        width: number,
        height: number,
        sun: Sun,
        shadowMapView: GPUTextureView,
        smokeTransmittanceView: GPUTextureView,
    ): void {
        this.ensureTargets(width, height);
        this.ensureFrameBindGroup(shadowMapView, smokeTransmittanceView);

        //---- 1. agrupamento (idêntico ao MainRenderPass) ----
        const items: DrawItem[] = [];
        let cameraNode: Node | null = null;
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node; //primeira câmera achada é A câmera
            }
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
            let p = 0;
            this.frameData.set(view, p);
            p += FLOATS_PER_MAT4;
            this.frameData.set(cam.camera!.getProjectionMatrix(), p);
            p += FLOATS_PER_MAT4;
            this.frameData.set(cam.position, p); //cameraPos (vec4f, w fica 0)
            p += 4;
            this.frameData.set(sun.dir, p); //sunDir.xyz
            this.frameData[p + 3] = sun.intensity; //sunDir.w
            p += 4;
            this.frameData.set(sun.color, p);
            this.frameData[p + 3] = 0;
            p += 4;
            this.frameData.set(sun.viewProj, p);
            this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
        } else if (items.length > 0) {
            console.warn("SunScenePass: nenhum nó com camera no mundo — nada será desenhado.");
            items.length = 0;
        }

        if (items.length > this.objectCapacity) {
            this.growObjectBuffer(items.length);
        }
        items.forEach((item, i) => {
            const base = i * FLOATS_PER_OBJECT;
            this.modelData.set(item.world, base);
            this.modelData.set(
                mat4.transpose(mat4.invert(item.world)),
                base + FLOATS_PER_MAT4,
            );
        });
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer, 0, this.modelData, 0,
                items.length * FLOATS_PER_OBJECT,
            );
        }

        //---- 3. draw, na mesma ordem do envio ----
        const pass = encoder.beginRenderPass({
            label: "sun scene pass",
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
        pass.setBindGroup(BIND_GROUP_FRAME, this.frameBindGroup!);
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
            pass.drawIndexed(mesh.indexCount, 1, 0, 0, i);
        });
        pass.end();
    }

    //Shadow map e transmitância têm views ESTÁVEIS (texturas de tamanho fixo,
    //criadas uma vez) — na prática isto roda uma vez; a comparação é só rede
    //de segurança.
    private ensureFrameBindGroup(shadowView: GPUTextureView, smokeTView: GPUTextureView): void {
        if (this.frameBindGroup && shadowView === this.lastShadowView && smokeTView === this.lastSmokeTView) {
            return;
        }
        this.frameBindGroup = this.device.createBindGroup({
            label: "sun scene frame",
            layout: this.ctx.frameBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.frameBuffer } },
                { binding: 1, resource: shadowView },
                { binding: 2, resource: this.shadowSampler },
                { binding: 3, resource: smokeTView },
                { binding: 4, resource: this.smokeTSampler },
            ],
        });
        this.lastShadowView = shadowView;
        this.lastSmokeTView = smokeTView;
    }

    private growObjectBuffer(minObjects: number): void {
        let capacity = Math.max(this.objectCapacity, 64);
        while (capacity < minObjects) {
            capacity *= 2;
        }
        this.objectBuffer?.destroy();
        this.objectCapacity = capacity;
        this.modelData = new Float32Array(capacity * FLOATS_PER_OBJECT);
        this.objectBuffer = this.device.createBuffer({
            label: "sun scene model matrices",
            size: capacity * FLOATS_PER_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "sun scene objeto",
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

    /** Garante os alvos no tamanho pedido (recria só quando muda). */
    ensureTargets(width: number, height: number): void {
        if (this.colorTexture && this.colorTexture.width === width && this.colorTexture.height === height) {
            return;
        }
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = this.device.createTexture({
            label: "sun scene color",
            size: [width, height],
            format: this.ctx.colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "sun scene depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            //TEXTURE_BINDING: o SmokeVolumePass amostra este depth pra oclusão.
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._colorView = this.colorTexture.createView();
        this._depthView = this.depthTexture.createView();
    }
}
