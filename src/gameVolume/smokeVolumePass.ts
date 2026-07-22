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
//
//SHADING (single scattering): fumaça é MEIO PARTICIPANTE, não superfície —
//não existe normal/gradiente útil num campo advectado suave; o que dá "cara
//de fumaça" é responder "quanta luz do SOL chega viva em cada amostra?".
//Por amostra densa da marcha primária:
//  - AUTO-SOMBRA: uma 2ª marcha, rumo ao sol, acumula profundidade óptica τ
//    (a mesma Beer-Lambert do olho, na direção da luz) → T = exp(-τ);
//  - sombra da GEOMETRIA: 1 tap no shadow map do sol (o SmokeBlocker sombreia
//    a fumaça embaixo dele);
//  - fase HENYEY-GREENSTEIN (constante por pixel: sol direcional + raio fixo):
//    espalhamento preferencial pra FRENTE → "silver lining" em contraluz;
//  - AMBIENTE constante fingindo multiple scattering (senão o lado sombreado
//    vira breu — fumaça real rebate luz internamente).
//A simulação foi SEPARADA do render (simulate()): o mundo roda o compute
//ANTES dos passes de sombra, que já leem a densidade deste frame.
import { mat4 } from "wgpu-matrix";
import { gpuTimer } from "../gpuTimer";
import { Node } from "../node";
import { StaticMesh } from "../mesh";
import { collectSmokeSources } from "./smokeBehaviour";
import type { Sun } from "./sun";

//Recursos de render POR fonte (node). O uniform é persistente; o bind group
//se recria quando a densidade (ping-pong, todo frame) ou o depth (resize) muda.
interface SmokeEntry {
    uniformBuffer: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    bindGroup: GPUBindGroup | null;
    lastDensityView: GPUTextureView | null;
    lastDepthView: GPUTextureView | null;
    lastShadowView: GPUTextureView | null;
}

//Passo local de amostragem: 1/96 dá ~96 amostras num raio axial e ~166 na
//diagonal do cubo (√3). MAX_STEPS cobre a diagonal com folga.
const DEFAULT_STEP = 1 / 96;
const FLOATS =
    16 /*view*/ + 16 /*proj*/ + 16 /*invViewProj*/ + 16 /*model*/ +
    16 /*lightViewProj*/ +
    4 /*p0*/ + 4 /*p1*/ + 4 /*p2*/ + 4 /*p3*/ + 4 /*color*/; //= 100 floats, 400 bytes

const SMOKE_WGSL = /* wgsl */ `
struct U {
    view: mat4x4f,
    proj: mat4x4f,
    invViewProj: mat4x4f,  //inversa de proj*view — reconstrói mundo a partir do depth
    model: mat4x4f,        //do cubo do volume (leva local↔mundo)
    lightViewProj: mat4x4f, //mundo → clip do SOL (mesmo contrato do shadow pass)
    p0: vec4f,             //x=time, y=stepSize, z=densityScale, w=coverage
    p1: vec4f,             //xyz=direção de propagação do sol (mundo), w=intensidade
    p2: vec4f,             //rgb=cor do sol, w=luz ambiente (multiple scattering fingido)
    p3: vec4f,             //x=g (Henyey-Greenstein), y=bias do shadow map, zw livres
    color: vec4f,          //rgb=albedo da fumaça, a=sigma (extinção Beer-Lambert)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var densityField: texture_3d<f32>; //densidade advectada (compute), .r
@group(0) @binding(3) var sceneDepth: texture_depth_2d; //depth dos opacos (clip z [0,1])
@group(0) @binding(4) var shadowMap: texture_depth_2d;  //shadow map do sol
@group(0) @binding(5) var shadowSamp: sampler_comparison;

const MAX_STEPS: i32 = 192;
//Marcha de LUZ (auto-sombra): mais grossa que a primária — sombra de fumaça é
//suave por natureza, não precisa da mesma resolução. 16 passos de 1/32 cobrem
//0.5 de espaço local = do centro até a face do cubo.
const LIGHT_STEPS: i32 = 16;
const LIGHT_STEP: f32 = 1.0 / 32.0;

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

    //--- SOL: tudo que não varia ao longo do raio, fora do loop ---
    let sunDirW = normalize(u.p1.xyz); //propagação (sol→cena), mundo
    let sunIntensity = u.p1.w;
    let sunColor = u.p2.rgb;
    let ambient = u.p2.w;
    let g = u.p3.x;
    let shadowBias = u.p3.y;
    //Direção ATÉ a luz no espaço LOCAL: transforma o VETOR e normaliza DEPOIS
    //(a escala do cubo é não-uniforme — normalizar antes entortaria a direção).
    let toLightLocal = normalize(invLin * (-sunDirW));
    //Fase Henyey-Greenstein NORMALIZADA (=1 quando g=0): fumaça espalha luz
    //preferencialmente PRA FRENTE (g>0) → brilho de contraluz (silver lining).
    //Sol direcional + direção do raio fixa ⇒ o ângulo é o MESMO em todas as
    //amostras deste pixel — uma conta por fragmento, não por passo.
    let modelLin = mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz);
    let worldRd = normalize(modelLin * rd);
    let cosTheta = dot(sunDirW, -worldRd); //propagação · (amostra→câmera)
    let g2 = g * g;
    let phase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    //local → clip do sol num salto só (uma mat4·vec4 por amostra na marcha)
    let lvpm = u.lightViewProj * model;

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
            //--- AUTO-SOMBRA: 2ª marcha, rumo ao sol, acumulando prof. óptica τ ---
            var tau = 0.0;
            var lp = pLocal + toLightLocal * (LIGHT_STEP * 0.5);
            for (var j = 0; j < LIGHT_STEPS; j = j + 1) {
                let luvw = lp + vec3f(0.5);
                if (any(luvw < vec3f(0.0)) || any(luvw > vec3f(1.0))) {
                    break; //fora da caixa: o clamp-to-edge repetiria a borda pra sempre
                }
                var ld = sampleSmoke(luvw);
                ld = smoothstep(coverage, 1.0, ld) * densityScale;
                tau += ld * sigma * LIGHT_STEP;
                if (tau > 4.5) {
                    break; //exp(-4.5) ≈ 1%: já é sombra total, parar de amostrar
                }
                lp += toLightLocal * LIGHT_STEP;
            }
            let lightT = exp(-tau); //fração da luz do sol que chega VIVA aqui

            //--- sombra da GEOMETRIA sobre a fumaça: 1 tap no shadow map ---
            //(o jitter da marcha já dithera a borda; PCF aqui seria luxo)
            let lclip = lvpm * vec4f(pLocal, 1.0);
            let suv = vec2f(lclip.x * 0.5 + 0.5, 0.5 - lclip.y * 0.5);
            var vis = 1.0;
            if (all(suv >= vec2f(0.0)) && all(suv <= vec2f(1.0)) && lclip.z >= 0.0 && lclip.z <= 1.0) {
                vis = textureSampleCompareLevel(shadowMap, shadowSamp, suv, lclip.z - shadowBias);
            }

            //Luz da amostra: ambiente + sol·fase·auto-sombra·sombra da geometria,
            //tudo tingido pelo albedo. É isto que dá topo claro / barriga escura.
            let sampleLight = u.color.rgb * (ambient + sunColor * sunIntensity * phase * lightT * vis);

            //Beer-Lambert por passo: opacidade cresce com densidade·extinção·passo.
            let alpha = 1.0 - exp(-d * sigma * step);
            let w = (1.0 - acc.a) * alpha;
            acc = vec4f(acc.rgb + w * sampleLight, acc.a + w);
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
    private readonly shadowSampler: GPUSampler;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    //Recursos de render por fonte (node) — ver SmokeEntry.
    private readonly cache = new Map<Node, SmokeEntry>();

    //Tunables da fumaça, aplicados a TODAS as fontes (defaults da escala do
    //gameVolume). Se um dia forem por-fonte, migram pra config do SmokeBehaviour.
    stepSize = DEFAULT_STEP;
    densityScale = 1.0;
    coverage = 0.48;          //quanto maior, menos fumaça (mais ar limpo)
    color: [number, number, number] = [0.85, 0.87, 0.92]; //albedo
    sigma = 10.0;             //coeficiente de extinção (Beer-Lambert)
    ambient = 0.35;           //piso de luz fingindo multiple scattering
    hgG = 0.35;               //g da fase Henyey-Greenstein (0=isotrópico, →1 pra frente)
    shadowBias = 0.0015;      //bias de leitura do shadow map (anti-acne)

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
                //shadow map do sol + sampler de comparação (sombra da geometria na fumaça)
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
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
        //Comparação "less" casa com o depthCompare do shadow pass do sol.
        this.shadowSampler = device.createSampler({
            label: "smoke shadow comparison sampler",
            compare: "less",
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
     * Roda um passo da SIMULAÇÃO de cada fonte (compute). Separado do render
     * porque os passes de sombra (shadow map da cena e transmitância da
     * fumaça) rodam ANTES do desenho do volume e precisam da densidade JÁ
     * advectada deste frame — o mundo chama isto primeiro.
     */
    simulate(encoder: GPUCommandEncoder, root: Node): void {
        for (const { behaviour } of collectSmokeSources(root)) {
            behaviour.simulate(encoder);
        }
    }

    /**
     * Coleta de `root` os nodes com SmokeBehaviour e compõe cada um sobre
     * `colorView` (loadOp "load"), ocluídos por `sceneDepthView` (o depth dos
     * opacos, amostrado 1:1). Para cada fonte: escreve seu uniform (view/proj
     * do `cameraNode` + a model matrix do node = origem do volume + o sol do
     * frame) e desenha o cubo proxy. `width`/`height` têm que casar com o alvo
     * da geometria (indexação do depth). A simulação já rodou em simulate().
     */
    render(
        encoder: GPUCommandEncoder,
        colorView: GPUTextureView,
        sceneDepthView: GPUTextureView,
        cameraNode: Node,
        root: Node,
        width: number,
        height: number,
        sun: Sun,
        shadowMapView: GPUTextureView,
    ): void {
        const sources = collectSmokeSources(root);
        if (sources.length === 0) {
            return; //sem fumaça: a cor dos opacos segue intacta pro finalPass
        }

        const cam = cameraNode.camera!;
        cam.aspect = width / height;
        const view = mat4.invert(cameraNode.worldMatrix); //invert não muta a fonte
        const proj = cam.getProjectionMatrix();
        const invViewProj = mat4.invert(mat4.multiply(proj, view));

        //Uniform + bind group de cada fonte (buffers separados por node →
        //sem o problema de writeBuffer deferido multiplexando um só buffer).
        for (const { node, behaviour } of sources) {
            const e = this.entryFor(node);
            const d = e.data;
            d.set(view, 0);
            d.set(proj, 16);
            d.set(invViewProj, 32);
            d.set(node.worldMatrix, 48); //origem/tamanho do volume vêm do node
            d.set(sun.viewProj, 64);
            d[80] = 0; d[81] = this.stepSize; d[82] = this.densityScale; d[83] = this.coverage;
            d[84] = sun.dir[0]; d[85] = sun.dir[1]; d[86] = sun.dir[2]; d[87] = sun.intensity;
            d[88] = sun.color[0]; d[89] = sun.color[1]; d[90] = sun.color[2]; d[91] = this.ambient;
            d[92] = this.hgG; d[93] = this.shadowBias; d[94] = 0; d[95] = 0;
            d[96] = this.color[0]; d[97] = this.color[1]; d[98] = this.color[2]; d[99] = this.sigma;
            this.device.queue.writeBuffer(e.uniformBuffer, 0, d);

            const densityView = behaviour.densityView;
            if (densityView !== e.lastDensityView || sceneDepthView !== e.lastDepthView
                || shadowMapView !== e.lastShadowView) {
                e.bindGroup = this.device.createBindGroup({
                    label: "smoke volume bind group",
                    layout: this.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: e.uniformBuffer } },
                        { binding: 1, resource: this.sampler },
                        { binding: 2, resource: densityView },
                        { binding: 3, resource: sceneDepthView },
                        { binding: 4, resource: shadowMapView },
                        { binding: 5, resource: this.shadowSampler },
                    ],
                });
                e.lastDensityView = densityView;
                e.lastDepthView = sceneDepthView;
                e.lastShadowView = shadowMapView;
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
                lastShadowView: null,
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
