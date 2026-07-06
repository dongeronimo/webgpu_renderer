import { mat4, Mat4, quat, vec3, utils } from "wgpu-matrix";
import { BIND_GROUP_FRAME, BIND_GROUP_MATERIAL, BIND_GROUP_OBJECT, Material, PipelineContext } from "../material";
import { Renderable, RenderPassBit } from "../renderable";
import { Node } from "../node";
import { gpuTimer } from "../gpuTimer";
import { Camera } from "../camera";
import { DebugSliceMaterial } from "./debugSliceMaterial";

const FLOATS_PER_MAT4 = 16;
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

//Ângulos da órbita da câmera de debug ao redor do volume (a origem). De
//frente as fatias são edge-on (viram linhas); só de um ângulo lateral dá
//pra ver a pilha separada — por isso a câmera ORBITA, não gira no lugar.
const DEBUG_ORBIT_YAW_DEG = 60;   //azimute, em torno do up do mundo
const DEBUG_ORBIT_PITCH_DEG = 20; //elevação, em torno do right do mundo
//EXPLODED VIEW: as fatias são contíguas e opacas — de lado, as da frente
//tapam as de trás e viram um bloco sólido. Aqui cada fatia é afastada ao
//longo do eixo de empilhamento (o forward da câmera principal) pra elas
//aparecerem separadas. Só no debug pass; o volume de verdade não muda.
const DEBUG_EXPLODE_GAP = 0.02; //afastamento entre fatias vizinhas
//slot de instância no bufferzão: model + normalMatrix (struct ObjectData
//nos shaders deste pass)
const FLOATS_PER_OBJECT = 2 * FLOATS_PER_MAT4;

interface DrawItem {
    renderable: Renderable;
    material: Material;
    pipeline: GPURenderPipeline;
    world: Mat4;
}

export class DebugSlicesPass {
    private readonly device: GPUDevice;
    private readonly ctx: PipelineContext;

    //grupo 0: view (64 bytes) + proj (64 bytes) + 
    //cameraPos (16 bytes), no layout do struct Frame
    private readonly frameBuffer: GPUBuffer;
    private readonly frameBindGroup: GPUBindGroup;
    private readonly frameData = new Float32Array(2 * FLOATS_PER_MAT4 + 16 + 16);

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

    //material de debug: cor sólida + phong só diffuse. Dono desta instância
    //(destruído no destroy()); o mesmo pra todas as fatias deste pass.
    private readonly debugMaterial: DebugSliceMaterial;

    //câmera de debug: nó SOLTO (fora da árvore do World), criado UMA vez no
    //primeiro render e reusado — orbita o volume pra ver as fatias de lado.
    private debugCamera: Node | null = null;
    // A gente cria o bind group do grupo 0 (informaçaõ de frame) e do grupo 1 (informação de instância 
    // de objeto). Tb fazemos resize do buffer de instância de objeto aqui, inicialmente pra 64.
    constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
        this.device = device;
        this.debugMaterial = new DebugSliceMaterial(device);
        //layout do grupo 0
        const frameBindGroupLayout = device.createBindGroupLayout({
            label: "DebugSlicesPass frame (grupo 0)",
            entries: [
                {
                    binding: 0,
                    //FRAGMENT também: o shading lê frame.cameraPos pro
                    //vetor de view do especular
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
            ],
        });
        //layout do grupo 1
        const objectBindGroupLayout = device.createBindGroupLayout({
            label: "transparent slices objeto (grupo 1)",
            entries: [
                {
                    binding: 0,
                    //FRAGMENT também: é lá que a normal matrix é usada
                    //(matriz não atravessa @location — ver comentário no topo)
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
            label: "DebugSlicesPass frame (view + proj)",
            size: this.frameData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.frameBindGroup = device.createBindGroup({
            label: "DebugSlicesPass frame",
            layout: frameBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
        });
        this.growObjectBuffer(64);
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
            label: "transparent slices object data (model + normal matrix)",
            size: capacity * FLOATS_PER_OBJECT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.objectBindGroup = this.device.createBindGroup({
            label: "transparent slices objeto",
            layout: this.ctx.objectBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
        });
    }
    
    /** A textura de cor com o resultado do debug — o que o overlay compõe. */
    get colorView(): GPUTextureView {
        if (!this._colorView) {
            throw new Error("DebugSlicesPass.colorView lido antes do primeiro render().");
        }
        return this._colorView;
    }

    render(encoder: GPUCommandEncoder, root: Node, width: number, height: number,
        mainCameraNode:Node): void {
        this.ensureTargets(width, height);
        //---- 1. coleta — SEM sort, a ordem da árvore É a ordem de draw  ----
        const items: DrawItem[] = [];
        const collect = (node: Node) => {
            //só desenha quem aceita este pass — objetos comuns (bit Main)
            //vivem na mesma árvore mas não entram aqui
            if (node.renderable && node.renderable.passMask & RenderPassBit.TransparentSlices) {
                const material = this.debugMaterial;
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
        //---- 2. envio: a câmera de debug (orbita o volume) escreve o Frame ----
        const debugCam = this.updateDebugCamera(mainCameraNode, width / height);
        //nó SOLTO: a worldMatrix cacheada nunca é atualizada por travessia,
        //então computa a matriz de mundo na hora (sem pai, é O(1)).
        this.frameData.set(mat4.invert(debugCam.getWorldMatrix()), 0);
        this.frameData.set(debugCam.camera!.getProjectionMatrix(), FLOATS_PER_MAT4);
        this.frameData.set(debugCam.position, FLOATS_PER_MAT4 + FLOATS_PER_MAT4);
        this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
        if(items.length > this.objectCapacity) {
            this.growObjectBuffer(items.length);
        }
        //eixo de explosão = forward da câmera principal em mundo (as fatias
        //são empilhadas nele). -Z da worldMatrix = forward (col. 8-10).
        const cw = mainCameraNode.worldMatrix;
        let fx = -cw[8], fy = -cw[9], fz = -cw[10];
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;
        const center = (items.length - 1) / 2; //explode simétrico ao redor do meio
        items.forEach((item, i)=>{
            const base = i * FLOATS_PER_OBJECT;
            this.modelData.set(item.world, base);
            //afasta a fatia no mundo ao longo do forward (col. 12-14 = trans-
            //lação). Rotação/escala intactas; a normal matrix nem é usada
            //pelo material de debug (normal vem do dpdx/dpdy), mas mantemos
            //o slot com a original — translação não afeta normais.
            const off = (center - i) * DEBUG_EXPLODE_GAP;
            this.modelData[base + 12] += fx * off;
            this.modelData[base + 13] += fy * off;
            this.modelData[base + 14] += fz * off;
            this.modelData.set(
                mat4.transpose(mat4.invert(item.world)), //normal matrix = transpose(inverse(model))
                base + FLOATS_PER_MAT4,
            );
        });
        if (items.length > 0) {
            this.device.queue.writeBuffer(
                this.objectBuffer,
                0,
                this.modelData,
                0,
                items.length * FLOATS_PER_OBJECT,
            );
        }
        //---- 3. draw, na mesma ordem do envio ----
        const pass = encoder.beginRenderPass({
            label: "debug slices pass",
            timestampWrites: gpuTimer.timestampWrites("debugSlices"),
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
                depthStoreOp: "store",
            },
        });
        //binda os grupos
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

    //A câmera de debug ORBITA o volume (a origem): parte da posição da câmera
    //principal e gira esse offset por yaw/pitch, olhando de volta pra origem.
    //É um nó SOLTO (sem pai, fora da árvore do World), criado UMA vez e
    //reusado todo frame — nada de vazar um Node por frame. A projeção
    //acompanha a da câmera principal; só o aspect vem do tamanho do alvo.
    private updateDebugCamera(mainCameraNode: Node, aspect: number): Node {
        if (!this.debugCamera) {
            const cam = new Node();
            cam.name = "DebugCamera";
            cam.camera = new Camera();
            this.debugCamera = cam;
        }
        const node = this.debugCamera;
        const mainCam = mainCameraNode.camera!;
        node.camera!.fovY = mainCam.fovY;
        node.camera!.near = mainCam.near;
        node.camera!.far = mainCam.far;
        node.camera!.aspect = aspect;
        //offset câmera→volume: a worldMatrix da principal já foi atualizada
        //pela travessia do World neste frame (col. 12-14 = posição de mundo).
        //O alvo é a origem, então o offset é a própria posição.
        const w = mainCameraNode.worldMatrix;
        const offset = vec3.create(w[12], w[13], w[14]);
        //gira o offset: yaw em torno do up do mundo, pitch em torno do right.
        const orbit = quat.mul(
            quat.fromAxisAngle(vec3.create(0, 1, 0), utils.degToRad(DEBUG_ORBIT_YAW_DEG)),
            quat.fromAxisAngle(vec3.create(1, 0, 0), utils.degToRad(DEBUG_ORBIT_PITCH_DEG)),
        );
        vec3.transformQuat(offset, orbit, offset);
        vec3.copy(offset, node.position); //posição = origem + offset girado
        node.lookAt(vec3.create(0, 0, 0)); //olha de volta pro volume
        return node;
    }
    destroy(): void {
        this.debugMaterial.destroy();
        this.frameBuffer.destroy();
        this.objectBuffer.destroy();
        this.colorTexture?.destroy();
        this.depthTexture?.destroy();
        this.colorTexture = null;
        this.depthTexture = null;
        this._colorView = null;
        this.depthView = null;
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
            label: "debug slices color",
            size: [width, height],
            format: this.ctx.colorFormat,
            //RENDER_ATTACHMENT pra desenhar aqui, TEXTURE_BINDING pro
            //final pass poder ler na composição
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTexture = this.device.createTexture({
            label: "debug slices depth",
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._colorView = this.colorTexture.createView();
        this.depthView = this.depthTexture.createView();
    }
}