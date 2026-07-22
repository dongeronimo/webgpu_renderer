//TRANSMITÂNCIA da fumaça em light-space — é a SOMBRA QUE A FUMAÇA PROJETA na
//geometria. Um mapa 2D alinhado ao shadow map (mesma projeção ortho do sol):
//pra cada texel, marcha-se a densidade do volume ao longo do raio de luz
//acumulando profundidade óptica τ, e guarda-se T = exp(-τ) — a fração da luz
//do sol que ATRAVESSA a fumaça naquele raio. O material da geometria
//multiplica a luz direta por T (sombra suave, cinza, não binária).
//
//O truque que torna o mapa CORRETO com um só canal: a marcha para no primeiro
//opaco do raio (lido do shadow map). Assim T vale exatamente para o primeiro
//receptor de cada raio de luz; receptores atrás dele já estão na sombra dura
//do shadow map (luz direta = 0), então o valor de T lá é irrelevante. Sem esse
//clamp, o topo do SmokeBlocker seria escurecido pela fumaça que está EMBAIXO
//dele — sombra subindo, fisicamente errada.
//
//MULTI-FONTE: um draw por fonte com blend MULTIPLICATIVO (dst·src) sobre o
//alvo limpo em 1.0 — transmitâncias de volumes independentes se compõem por
//produto. Mesmo cache por-node do SmokeVolumePass (uniform próprio por fonte).
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import { collectSmokeSources } from "./smokeBehaviour";
import type { Sun } from "./sun";

export const TRANSMITTANCE_SIZE = 512;
export const TRANSMITTANCE_FORMAT: GPUTextureFormat = "r16float";

const FLOATS = 16 /*invLightViewProj*/ + 16 /*invModel*/ + 4 /*params0*/; //= 36, 144 bytes

interface TransEntry {
    uniformBuffer: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    bindGroup: GPUBindGroup | null;
    lastDensityView: GPUTextureView | null;
    lastShadowView: GPUTextureView | null;
}

const TRANSMITTANCE_WGSL = /* wgsl */ `
struct U {
    invLightViewProj: mat4x4f, //clip do sol → mundo
    invModel: mat4x4f,         //mundo → local do cubo do volume
    params0: vec4f,            //x=sigma, y=coverage, z=densityScale, w livre
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var densityField: texture_3d<f32>;
@group(0) @binding(3) var shadowMap: texture_depth_2d;

const STEPS: i32 = 64;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) ndc: vec2f, //xy do clip de light-space deste texel
};

//Triângulo fullscreen clássico (3 vértices, sem vertex buffer).
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VsOut;
    out.position = vec4f(pos[vi], 0.0, 1.0);
    out.ndc = pos[vi];
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //O raio de luz deste texel: near (z=0) e far (z=1) do clip do sol
    //desprojetados pra mundo, e daí pro espaço LOCAL do cubo — onde o slab é
    //[-0.5,0.5]³ e o sigma é calibrado por unidade local (MESMA convenção do
    //smoke pass; é isso que faz a sombra bater com a auto-sombra do volume).
    let nearH = u.invLightViewProj * vec4f(in.ndc, 0.0, 1.0);
    let farH = u.invLightViewProj * vec4f(in.ndc, 1.0, 1.0);
    let ro = (u.invModel * vec4f(nearH.xyz / nearH.w, 1.0)).xyz;
    let re = (u.invModel * vec4f(farH.xyz / farH.w, 1.0)).xyz;
    let rd = normalize(re - ro);

    //Interseção raio-caixa (slab) contra [-0.5,0.5]³, como no smoke pass.
    let invD = 1.0 / rd;
    let t0 = (vec3f(-0.5) - ro) * invD;
    let t1 = (vec3f(0.5) - ro) * invD;
    let tsmall = min(t0, t1);
    let tbig = max(t0, t1);
    let tNear = max(max(tsmall.x, tsmall.y), max(tsmall.z, 0.0));
    var tFar = min(min(tbig.x, tbig.y), tbig.z);
    if (tFar <= tNear) {
        return vec4f(1.0, 0.0, 0.0, 1.0); //raio não cruza o volume: passa tudo
    }

    //Para no primeiro OPACO (shadow map na mesma ndc): além dele a luz direta
    //já é zero, só interessa a fumaça entre o sol e essa superfície.
    let sdims = vec2f(textureDimensions(shadowMap));
    let suv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
    let texel = clamp(vec2i(suv * sdims), vec2i(0), vec2i(sdims) - vec2i(1));
    let sd = textureLoad(shadowMap, texel, 0);
    let sceneH = u.invLightViewProj * vec4f(in.ndc, sd, 1.0);
    let sceneL = (u.invModel * vec4f(sceneH.xyz / sceneH.w, 1.0)).xyz;
    tFar = min(tFar, dot(sceneL - ro, rd));
    if (tFar <= tNear) {
        return vec4f(1.0, 0.0, 0.0, 1.0);
    }

    //Marcha com passo ADAPTATIVO: o trecho útil dividido em STEPS fatias
    //(o texel inteiro tem o mesmo custo, cruze ele 0.1 ou 1.7 do cubo).
    let sigma = u.params0.x;
    let coverage = u.params0.y;
    let densityScale = u.params0.z;
    let stepT = (tFar - tNear) / f32(STEPS);
    var tau = 0.0;
    var t = tNear + stepT * 0.5;
    for (var i = 0; i < STEPS; i = i + 1) {
        let uvw = ro + rd * t + vec3f(0.5);
        var d = textureSampleLevel(densityField, samp, uvw, 0.0).r;
        //MESMO condicionamento do smoke pass (smoothstep de cobertura +
        //escala) — senão a sombra não corresponde à fumaça desenhada.
        d = smoothstep(coverage, 1.0, d) * densityScale;
        tau += d * sigma * stepT;
        t += stepT;
    }
    return vec4f(exp(-tau), 0.0, 0.0, 1.0);
}
`;

export class SmokeTransmittancePass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    private readonly cache = new Map<Node, TransEntry>();

    private readonly texture: GPUTexture;
    /** O mapa de transmitância — o material da geometria multiplica a luz direta por ele. */
    readonly view: GPUTextureView;

    //Tunables espelhados do SmokeVolumePass (o mundo sincroniza por frame):
    //a sombra TEM que usar os mesmos números da fumaça desenhada.
    sigma = 10.0;
    coverage = 0.08;
    densityScale = 1.0;

    constructor(device: GPUDevice) {
        this.device = device;

        this.bindGroupLayout = device.createBindGroupLayout({
            label: "smoke transmittance pass",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
            ],
        });
        this.sampler = device.createSampler({
            label: "smoke transmittance sampler",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            addressModeW: "clamp-to-edge",
        });

        const module = device.createShaderModule({ label: "smoke transmittance shader", code: TRANSMITTANCE_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "smoke transmittance pipeline",
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: {
                module,
                entryPoint: "fs",
                targets: [
                    {
                        format: TRANSMITTANCE_FORMAT,
                        //blend MULTIPLICATIVO: várias fontes compõem por produto
                        //sobre o clear em 1.0 (T total = T1·T2·...).
                        blend: {
                            color: { srcFactor: "dst", dstFactor: "zero" },
                            alpha: { srcFactor: "one", dstFactor: "zero" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
        });

        //Tamanho fixo (como o shadow map): resolução de sombra é knob próprio.
        //View estável → o bind group do scene pass nunca precisa recriar por ela.
        this.texture = device.createTexture({
            label: "smoke transmittance map",
            size: [TRANSMITTANCE_SIZE, TRANSMITTANCE_SIZE],
            format: TRANSMITTANCE_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.view = this.texture.createView();
    }

    /**
     * Recalcula o mapa: limpa em 1.0 e marcha cada fonte de fumaça com o sol
     * deste frame. Roda DEPOIS do shadow pass (lê o depth dele) e DEPOIS da
     * simulação (lê a densidade já advectada). Sem fontes, o pass só limpa —
     * o material da geometria amostra 1.0 e ninguém escurece.
     */
    render(encoder: GPUCommandEncoder, root: Node, sun: Sun, shadowDepthView: GPUTextureView): void {
        const sources = collectSmokeSources(root);

        const invLightViewProj = mat4.invert(sun.viewProj);
        for (const { node, behaviour } of sources) {
            const e = this.entryFor(node);
            e.data.set(invLightViewProj, 0);
            e.data.set(mat4.invert(node.worldMatrix), 16);
            e.data[32] = this.sigma;
            e.data[33] = this.coverage;
            e.data[34] = this.densityScale;
            e.data[35] = 0;
            this.device.queue.writeBuffer(e.uniformBuffer, 0, e.data);

            const densityView = behaviour.densityView;
            if (densityView !== e.lastDensityView || shadowDepthView !== e.lastShadowView) {
                e.bindGroup = this.device.createBindGroup({
                    label: "smoke transmittance bind group",
                    layout: this.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: e.uniformBuffer } },
                        { binding: 1, resource: this.sampler },
                        { binding: 2, resource: densityView },
                        { binding: 3, resource: shadowDepthView },
                    ],
                });
                e.lastDensityView = densityView;
                e.lastShadowView = shadowDepthView;
            }
        }

        const pass = encoder.beginRenderPass({
            label: "smoke transmittance pass",
            timestampWrites: gpuTimer.timestampWrites("smokeShadow"),
            colorAttachments: [
                {
                    view: this.view,
                    loadOp: "clear",
                    clearValue: { r: 1, g: 1, b: 1, a: 1 }, //T=1: sem fumaça, passa tudo
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        for (const { node } of sources) {
            pass.setBindGroup(0, this.cache.get(node)!.bindGroup!);
            pass.draw(3);
        }
        pass.end();
    }

    private entryFor(node: Node): TransEntry {
        let e = this.cache.get(node);
        if (!e) {
            e = {
                uniformBuffer: this.device.createBuffer({
                    label: "smoke transmittance uniform",
                    size: FLOATS * 4,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                }),
                data: new Float32Array(FLOATS),
                bindGroup: null,
                lastDensityView: null,
                lastShadowView: null,
            };
            this.cache.set(node, e);
        }
        return e;
    }

    destroy(): void {
        for (const e of this.cache.values()) {
            e.uniformBuffer.destroy();
        }
        this.cache.clear();
        this.texture.destroy();
    }
}
