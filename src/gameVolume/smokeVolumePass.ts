//Pass da FUMAÇA volumétrica integrada à cena. Roda DEPOIS do pass de
//geometria opaca, compondo o volume por cima da cor dos opacos (loadOp
//"load", blend premultiplied) e — o pulo do gato — LENDO o depth dos opacos
//pra ocluir a fumaça atrás da geometria. Assim a oclusão vale nos dois
//sentidos:
//  - geometria oclui volume: a marcha para na superfície opaca (clampa tFar
//    pela profundidade lida do depth buffer da cena);
//  - volume oclui geometria: a composição premultiplied cobre a cor opaca
//    onde a fumaça é densa.
//
//MULTI-FONTE: o pass COLETA da árvore os nodes que têm um SmokeBehaviour e
//desenha cada um (podem ser várias fontes de fumaça). Cada fonte carrega seu
//próprio uniform (view/proj/invViewProj/model + params) e amostra a densidade
//da SUA AdvectionSim + o depth da cena. Como não dá pra multiplexar UM uniform
//buffer entre draws no mesmo encoder (o writeBuffer é deferido), cada node tem
//seus recursos de render num CACHE por-node. SEM depth attachment: a oclusão é
//resolvida no shader lendo o depth como TEXTURA (textureLoad), sem hazard.
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import { StaticMesh } from "../mesh";
import { SmokeBehaviour } from "./smokeBehaviour";

//Recursos de render POR fonte (node). O uniform é persistente; o bind group
//se recria quando a densidade (ping-pong, todo frame) ou o depth (resize) muda.
interface SmokeEntry {
    uniformBuffer: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    bindGroup: GPUBindGroup | null;
    lastDensityView: GPUTextureView | null;
    lastDepthView: GPUTextureView | null;
}

//Passo local de amostragem: 1/96 dá ~96 amostras num raio axial e ~166 na
//diagonal do cubo (√3). MAX_STEPS cobre a diagonal com folga.
const DEFAULT_STEP = 1 / 96;
const FLOATS =
    16 /*view*/ + 16 /*proj*/ + 16 /*invViewProj*/ + 16 /*model*/ +
    4 /*p0*/ + 4 /*p1*/ + 4 /*color*/; //= 76 floats, 304 bytes

const SMOKE_WGSL = /* wgsl */ `
struct U {
    view: mat4x4f,
    proj: mat4x4f,
    invViewProj: mat4x4f,  //inversa de proj*view — reconstrói mundo a partir do depth
    model: mat4x4f,        //do cubo do volume (leva local↔mundo)
    p0: vec4f,             //x=time, y=stepSize, z=densityScale, w=coverage
    p1: vec4f,             //xyz=drift (por segundo), w=noiseScale
    color: vec4f,          //rgb=cor da fumaça, a=sigma (extinção Beer-Lambert)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var densityField: texture_3d<f32>; //densidade advectada (compute), .r
@group(0) @binding(3) var sceneDepth: texture_depth_2d; //depth dos opacos (clip z [0,1])

const MAX_STEPS: i32 = 192;

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) localPos: vec3f, //posição no cubo [-0.5,0.5]³ (interpolada)
};

@vertex
fn vs(@location(0) position: vec3f) -> VsOut {
    var out: VsOut;
    out.position = u.proj * u.view * u.model * vec4f(position, 1.0);
    out.localPos = position;
    return out;
}

//Ruído pseudo-aleatório [0,1) pela posição de tela — quebra o banding do passo.
fn ign(xy: vec2f) -> f32 {
    let magic = vec3f(0.06711056, 0.00583715, 52.9829189);
    return fract(magic.z * fract(dot(xy, magic.xy)));
}

//Inversa da parte linear 3x3 (WGSL não tem inverse). O cubo do volume tem
//escala não-uniforme, então precisa da inversa de verdade, não da transposta.
fn inverse3(m: mat3x3f) -> mat3x3f {
    let a = m[0]; let b = m[1]; let c = m[2];
    let r0 = cross(b, c);
    let r1 = cross(c, a);
    let r2 = cross(a, b);
    let invDet = 1.0 / dot(a, r0);
    return mat3x3f(
        vec3f(r0.x, r1.x, r2.x),
        vec3f(r0.y, r1.y, r2.y),
        vec3f(r0.z, r1.z, r2.z),
    ) * invDet;
}

//Densidade da fumaça: agora vem do campo ADVECTADO pelo compute — uma
//amostra trilinear em [0,1]³. A animação vem da simulação (advecção), não
//mais de deslocar coordenadas de ruído. Sampler é linear+clamp.
fn sampleSmoke(uvw: vec3f) -> f32 {
    return textureSampleLevel(densityField, samp, uvw, 0.0).r;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let view = u.view;
    let model = u.model;
    //Câmera-mundo a partir da view (view = inverse(cameraWorld), câmera rígida).
    let R = mat3x3f(view[0].xyz, view[1].xyz, view[2].xyz);
    let camWorld = -(transpose(R) * view[3].xyz);
    //Câmera no espaço LOCAL do cubo.
    let invLin = inverse3(mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz));
    let camLocal = invLin * (camWorld - model[3].xyz);
    let rd = normalize(in.localPos - camLocal);

    //Interseção raio-caixa (slab) contra [-0.5,0.5]³.
    let invD = 1.0 / rd;
    let t0 = (vec3f(-0.5) - camLocal) * invD;
    let t1 = (vec3f(0.5) - camLocal) * invD;
    let tsmall = min(t0, t1);
    let tbig = max(t0, t1);
    var tNear = max(max(tsmall.x, tsmall.y), tsmall.z);
    var tFar = min(min(tbig.x, tbig.y), tbig.z);
    tNear = max(tNear, 0.0); //câmera dentro da caixa: começa em t=0
    if (tFar <= tNear) {
        discard;
    }

    //--- OCLUSÃO: para a marcha na superfície opaca mais próxima deste pixel ---
    //O alvo do volume tem o MESMO tamanho do pass de geometria, então a
    //coordenada de fragmento indexa o texel de depth 1:1 (textureLoad, sem sampler).
    let dims = vec2f(textureDimensions(sceneDepth));
    let pix = vec2i(i32(in.position.x), i32(in.position.y));
    let sd = textureLoad(sceneDepth, pix, 0); //clip z [0,1]; 1.0 = fundo (sem geometria)
    //NDC deste pixel → mundo pela invViewProj (y de framebuffer é top-down).
    let ndc = vec3f(
        (in.position.x / dims.x) * 2.0 - 1.0,
        1.0 - (in.position.y / dims.y) * 2.0,
        sd,
    );
    let worldH = u.invViewProj * vec4f(ndc, 1.0);
    let sceneWorld = worldH.xyz / worldH.w;
    let sceneLocal = invLin * (sceneWorld - model[3].xyz);
    //Projeta o ponto opaco no MESMO parâmetro t da marcha (rd é a direção local).
    let tScene = dot(sceneLocal - camLocal, rd);
    tFar = min(tFar, tScene);
    if (tFar <= tNear) {
        discard; //opaco cobre o volume inteiro neste pixel
    }

    let step = u.p0.y;
    let densityScale = u.p0.z;
    let coverage = u.p0.w;
    let sigma = u.color.a;

    let jitter = ign(in.position.xy);
    var t = tNear + jitter * step;
    //Composição FRONT-TO-BACK, cor JÁ pré-multiplicada pela cobertura.
    var acc = vec4f(0.0);
    for (var i = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= tFar) {
            break;
        }
        let pLocal = camLocal + rd * t;
        let uvw = pLocal + vec3f(0.5); //[-0.5,0.5]³ → [0,1]³
        var d = sampleSmoke(uvw);
        //threshold suave = "cobertura": abaixo dela é ar limpo, acima vira fumaça.
        d = smoothstep(coverage, 1.0, d) * densityScale;
        if (d > 0.001) {
            //Beer-Lambert por passo: opacidade cresce com densidade·extinção·passo.
            let alpha = 1.0 - exp(-d * sigma * step);
            let w = (1.0 - acc.a) * alpha;
            acc = vec4f(acc.rgb + w * u.color.rgb, acc.a + w);
            if (acc.a >= 0.99) {
                break; //early ray termination
            }
        }
        t = t + step;
    }
    return acc; //pré-multiplicado — o pipeline usa blend premultiplied
}
`;

export class SmokeVolumePass {
    private readonly device: GPUDevice;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    //Recursos de render por fonte (node) — ver SmokeEntry.
    private readonly cache = new Map<Node, SmokeEntry>();

    //Tunables da fumaça, aplicados a TODAS as fontes (defaults da escala do
    //gameVolume). Se um dia forem por-fonte, migram pra config do SmokeBehaviour.
    stepSize = DEFAULT_STEP;
    densityScale = 1.0;
    coverage = 0.48;          //quanto maior, menos fumaça (mais ar limpo)
    color: [number, number, number] = [0.85, 0.87, 0.92];
    sigma = 10.0;             //coeficiente de extinção (Beer-Lambert)

    constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
        this.device = device;

        this.bindGroupLayout = device.createBindGroupLayout({
            label: "smoke volume pass",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                //densidade advectada (o compute a preenche); amostrada em [0,1]³
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                //depth dos opacos como textura amostrável (sampleType "depth", lido por textureLoad)
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
            ],
        });
        //Linear + clamp: a densidade é um campo em [0,1]³; clamp evita puxar
        //do lado oposto na borda (repeat era pro drift do ruído, que saiu).
        this.sampler = device.createSampler({
            label: "smoke density sampler",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            addressModeW: "clamp-to-edge",
        });

        const module = device.createShaderModule({ label: "smoke volume shader", code: SMOKE_WGSL });
        this.pipeline = device.createRenderPipeline({
            label: "smoke volume pipeline",
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module, entryPoint: "vs", buffers: [StaticMesh.vertexLayout] },
            fragment: {
                module,
                entryPoint: "fs",
                targets: [
                    {
                        format: colorFormat,
                        //saída pré-multiplicada compondo sobre a cor dos opacos
                        blend: {
                            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            //back-faces (cullMode "front"): 1 fragmento por pixel da silhueta
            //mesmo com a câmera dentro da caixa. SEM depthStencil: este pass não
            //tem depth attachment — a oclusão é resolvida no shader.
            primitive: { topology: "triangle-list", cullMode: "front" },
        });
    }

    /**
     * Coleta de `root` os nodes com SmokeBehaviour e compõe cada um sobre
     * `colorView` (loadOp "load"), ocluídos por `sceneDepthView` (o depth dos
     * opacos, amostrado 1:1). Para cada fonte: roda o passo da simulação
     * (`behaviour.simulate` — este pass é quem tem o encoder), escreve seu
     * uniform (view/proj do `cameraNode` + a model matrix do node = origem do
     * volume) e desenha o cubo proxy. `width`/`height` têm que casar com o alvo
     * da geometria (indexação do depth).
     */
    render(
        encoder: GPUCommandEncoder,
        colorView: GPUTextureView,
        sceneDepthView: GPUTextureView,
        cameraNode: Node,
        root: Node,
        width: number,
        height: number,
    ): void {
        const sources = this.collect(root);
        if (sources.length === 0) {
            return; //sem fumaça: a cor dos opacos segue intacta pro finalPass
        }

        const cam = cameraNode.camera!;
        cam.aspect = width / height;
        const view = mat4.invert(cameraNode.worldMatrix); //invert não muta a fonte
        const proj = cam.getProjectionMatrix();
        const invViewProj = mat4.invert(mat4.multiply(proj, view));

        //1. COMPUTE: um passo por fonte, ANTES do render pass. A barreira entre
        //o compute pass e o render pass garante a densidade escrita.
        for (const { behaviour } of sources) {
            behaviour.simulate(encoder);
        }

        //2. Uniform + bind group de cada fonte (buffers separados por node →
        //sem o problema de writeBuffer deferido multiplexando um só buffer).
        for (const { node, behaviour } of sources) {
            const e = this.entryFor(node);
            const d = e.data;
            d.set(view, 0);
            d.set(proj, 16);
            d.set(invViewProj, 32);
            d.set(node.worldMatrix, 48); //origem/tamanho do volume vêm do node
            d[64] = 0; d[65] = this.stepSize; d[66] = this.densityScale; d[67] = this.coverage;
            d[68] = 0; d[69] = 0; d[70] = 0; d[71] = 0; //p1 livre (não há mais drift)
            d[72] = this.color[0]; d[73] = this.color[1]; d[74] = this.color[2]; d[75] = this.sigma;
            this.device.queue.writeBuffer(e.uniformBuffer, 0, d);

            const densityView = behaviour.densityView;
            if (densityView !== e.lastDensityView || sceneDepthView !== e.lastDepthView) {
                e.bindGroup = this.device.createBindGroup({
                    label: "smoke volume bind group",
                    layout: this.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: e.uniformBuffer } },
                        { binding: 1, resource: this.sampler },
                        { binding: 2, resource: densityView },
                        { binding: 3, resource: sceneDepthView },
                    ],
                });
                e.lastDensityView = densityView;
                e.lastDepthView = sceneDepthView;
            }
        }

        //3. UM render pass, um draw por fonte (compõem em sequência sobre a cor).
        const pass = encoder.beginRenderPass({
            label: "smoke volume pass",
            timestampWrites: gpuTimer.timestampWrites("volume"),
            colorAttachments: [
                { view: colorView, loadOp: "load", storeOp: "store" },
            ],
        });
        pass.setPipeline(this.pipeline);
        for (const { node } of sources) {
            const e = this.cache.get(node)!;
            const mesh = node.renderable!.mesh;
            pass.setBindGroup(0, e.bindGroup!);
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            pass.drawIndexed(mesh.indexCount);
        }
        pass.end();
    }

    /** Nodes da árvore que têm SmokeBehaviour (e um Renderable = o cubo proxy). */
    private collect(root: Node): { node: Node; behaviour: SmokeBehaviour }[] {
        const out: { node: Node; behaviour: SmokeBehaviour }[] = [];
        const visit = (n: Node) => {
            const b = n.behaviours.find(x => x instanceof SmokeBehaviour) as SmokeBehaviour | undefined;
            if (b && n.renderable) {
                out.push({ node: n, behaviour: b });
            }
            for (const c of n.children) {
                visit(c);
            }
        };
        visit(root);
        return out;
    }

    private entryFor(node: Node): SmokeEntry {
        let e = this.cache.get(node);
        if (!e) {
            e = {
                uniformBuffer: this.device.createBuffer({
                    label: "smoke volume uniform",
                    size: FLOATS * 4,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                }),
                data: new Float32Array(FLOATS),
                bindGroup: null,
                lastDensityView: null,
                lastDepthView: null,
            };
            this.cache.set(node, e);
        }
        return e;
    }

    /** Libera os uniforms por-fonte (pipeline/sampler vivem com a app; as
     *  densidades são das AdvectionSim, liberadas pelo dispose das behaviours). */
    destroy(): void {
        for (const e of this.cache.values()) {
            e.uniformBuffer.destroy();
        }
        this.cache.clear();
    }
}
