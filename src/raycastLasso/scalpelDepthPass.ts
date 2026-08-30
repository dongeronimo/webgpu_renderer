//O passe que captura a PROFUNDIDADE DA SUPERFÍCIE VISÍVEL, do ponto de vista
//congelado de um bisturi. É o "shadow map" do corte: a luz é a câmera do
//instante do traço, e o que se guarda é a distância até a primeira superfície.
//
//QUANDO RODA: uma vez, quando um bisturi é fechado. NUNCA por frame, e nem
//quando a CTF muda — cada bisturi carrega a CTF dele congelada no dado, então
//o mapa dele nunca envelhece. Por isso é um passe
//dedicado e não um alvo extra do passe principal: um MRT no raymarch pagaria
//banda todo frame por um dado usado uma vez por laçada, e ainda amarraria a
//resolução do mapa ao framebufferScale, que é um knob de PERFORMANCE — mexer
//nele mudaria a qualidade de cortes já feitos.
//
//O QUE ELE GRAVA: DOIS valores por pixel (rg32float) — onde a primeira camada
//de material COMEÇA e onde ela ACABA. Não é preciosismo: com só a entrada, o
//corte vira uma fatia de espessura fixa, e estrutura curva (uma costela, que
//mergulha pra longe da câmera) sai truncada em cotocos, enquanto aumentar a
//espessura pra pegar o resto começa a comer o que está atrás. Com a saída, a
//casca tem a espessura DA PRÓPRIA ESTRUTURA em cada pixel.
//
//O QUE É UMA SUPERFÍCIE, num volume que não tem nenhuma:
//
//  primário: o primeiro ponto com |∇f| alto E alpha da CTF acima do mínimo.
//            É a classificação do Levoy (1988): fronteira de material que a
//            transferência atual não esconde. Pousa EXATAMENTE na interface.
//  rede:     se isso nunca disparar (rampa suave de densidade, sem fronteira),
//            vale o t em que a opacidade acumulada passou de 0.9. Menos
//            preciso — acerta atrasado, já dentro do material — mas é melhor
//            que não achar nada.
//  nada:     raio que só atravessou ar devolve NO_SURFACE (1e30) nos dois
//            canais. A faixa fica vazia e o corte não remove nada ali, sem
//            precisar de caso especial no shader principal.
//
//E ONDE ELA ACABA: o primeiro ponto, depois da entrada, em que o alpha da CTF
//cai abaixo do mínimo E FICA baixo por alguns passos seguidos. A histerese não
//é opcional — ruído de CT faz o alpha piscar dentro do osso, e sem exigir uma
//sequência a camada terminaria no primeiro voxel ruim. Camada que não acaba
//dentro da caixa termina na saída da caixa.
//
//A magnitude do gradiente sai de graça: o gradientCompute já guarda
//saturate(|∇f|/maxMagnitude) no ALPHA da textura de gradiente.
import { bakeCtfLut, CTF_LUT_WIDTH, type CtfPoint } from "../ctf";
import type { Mat4 } from "wgpu-matrix";

/** Lado do mapa de profundidade. Igual ao da máscara: mesmo uv, mesmo texel. */
export const SCALPEL_DEPTH_SIZE = 512;

/** Sentinela de "esse raio não achou superfície nenhuma". */
export const NO_SURFACE = 1e30;

/** Os dois limiares que definem superfície. Ver o cabeçalho. */
export interface SurfaceThresholds {
    /** |∇f| normalizado por maxMagnitude, em [0,1]. */
    gradMin: number;
    /** Alpha da CTF em [0,1]. */
    alphaMin: number;
}

export const DEFAULT_SURFACE_THRESHOLDS: SurfaceThresholds = {
    //Folgado o bastante pra ficar acima do ruído do CT (em ar o gradiente é
    //pequeno perto do salto ar→pele, ~1000 HU) e baixo pra pegar fronteiras de
    //tecido mole.
    gradMin: 0.15,
    //"Pelo menos 10% opaco": abaixo disso a CTF está dizendo que aquilo mal
    //aparece, então não é a superfície que o usuário está vendo.
    alphaMin: 0.1,
};

const DEPTH_STEP = 1 / 512; //passo da marcha da captura, no espaço da caixa
const MAX_STEPS = 1024;
//Quantos passos seguidos de alpha baixo confirmam o fim da camada. 4 passos
//(~0.8% da caixa) atravessam ruído sem atravessar o vão entre duas costelas.
const EXIT_RUN = 4;

const SCALPEL_DEPTH_WGSL = /* wgsl */ `
struct Params {
    clipFromLocal: mat4x4f, //pLocal → clip da câmera congelada
    localFromClip: mat4x4f, //a inversa: desprojeta o pixel de volta pro volume
    ctfMin: f32,
    ctfMax: f32,
    stepSize: f32,
    gradMin: f32,
    alphaMin: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var volume: texture_3d<f32>;
@group(0) @binding(3) var gradient: texture_3d<f32>; //rgb=direção, A=|∇f| normalizado
@group(0) @binding(4) var ctfLut: texture_2d<f32>;   //LUT 1D da CTF (width×1)

const NO_SURFACE: f32 = 1e30;
const MAX_STEPS: i32 = ${MAX_STEPS};
//Opacidade acumulada que dispara a rede de segurança.
const FALLBACK_ALPHA: f32 = 0.9;
//Passos seguidos de alpha baixo que confirmam o fim da camada (histerese).
const EXIT_RUN: i32 = ${EXIT_RUN};

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) ndc: vec2f,
};

//Triângulo de tela cheia sem vertex buffer: os 3 vértices saem do índice.
@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VsOut;
    out.pos = vec4f(corners[index], 0.0, 1.0);
    out.ndc = corners[index];
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    //Desprojeta dois pontos do mesmo pixel (z=0 é o near, z=1 é o far — o clip
    //do WebGPU tem z em [0,1], não em [-1,1] como o do OpenGL) e tira o raio
    //DAQUELA câmera, já no espaço local do volume.
    let pNear = params.localFromClip * vec4f(in.ndc, 0.0, 1.0);
    let pFar = params.localFromClip * vec4f(in.ndc, 1.0, 1.0);
    let ro = pNear.xyz / pNear.w;
    let rd = normalize(pFar.xyz / pFar.w - ro);

    //Interseção raio-caixa (slab) contra [-0.5,0.5]³, igual à do raymarch.
    let invD = 1.0 / rd;
    let t0 = (vec3f(-0.5) - ro) * invD;
    let t1 = (vec3f(0.5) - ro) * invD;
    let tsmall = min(t0, t1);
    let tbig = max(t0, t1);
    var tNear = max(max(max(tsmall.x, tsmall.y), tsmall.z), 0.0);
    let tFar = min(min(tbig.x, tbig.y), tbig.z);
    if (tFar <= tNear) {
        return vec4f(NO_SURFACE, NO_SURFACE, 0.0, 1.0);
    }

    let range = max(params.ctfMax - params.ctfMin, 1e-6);
    //entry = onde a camada começa; exitD = onde ela acaba. NO_SURFACE = ainda
    //não achei. A marcha tem duas fases: enquanto entry é NO_SURFACE procura a
    //superfície; depois disso procura o fim do material.
    var entry = NO_SURFACE;
    var exitD = NO_SURFACE;
    var acc = 0.0;
    var lowRun = 0;
    var t = tNear;
    for (var i = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= tFar) {
            break;
        }
        let p = ro + rd * t;
        let uvw = p + vec3f(0.5);
        let s = textureSampleLevel(volume, samp, uvw, 0.0).r;
        let u = (s - params.ctfMin) / range;
        let alpha = textureSampleLevel(ctfLut, samp, vec2f(u, 0.5), 0.0).a;
        //A magnitude do gradiente é o alpha da textura de gradiente.
        let mag = textureSampleLevel(gradient, samp, uvw, 0.0).a;
        let depth = (params.clipFromLocal * vec4f(p, 1.0)).w;

        if (entry >= NO_SURFACE) {
            //FASE 1 — achar a superfície.
            //Critério primário: fronteira de material que a CTF não esconde.
            if (mag > params.gradMin && alpha > params.alphaMin) {
                entry = depth;
            } else {
                //REDE: opacidade acumulada. Se ninguém achou fronteira mas o
                //raio já está atravessando coisa opaca, aceita aqui — acerta
                //atrasado, mas é melhor que não achar nada.
                acc = acc + (1.0 - acc) * alpha;
                if (acc > FALLBACK_ALPHA) {
                    entry = depth;
                }
            }
        } else {
            //FASE 2 — achar onde essa camada acaba. HISTERESE: um voxel ruim
            //não termina a camada; só uma sequência de EXIT_RUN passos com
            //alpha baixo. O fim registrado é o PRIMEIRO da sequência, não o
            //último — senão a casca comeria a folga inteira da histerese.
            if (alpha <= params.alphaMin) {
                lowRun = lowRun + 1;
                if (lowRun == 1) {
                    exitD = depth;
                }
                if (lowRun >= EXIT_RUN) {
                    break;
                }
            } else {
                lowRun = 0;
                exitD = NO_SURFACE;
            }
        }
        t = t + params.stepSize;
    }

    if (entry >= NO_SURFACE) {
        //Raio só de ar: nenhuma camada pra remover.
        return vec4f(NO_SURFACE, NO_SURFACE, 0.0, 1.0);
    }
    if (exitD >= NO_SURFACE) {
        //A camada não acabou dentro do volume — termina na saída da caixa.
        exitD = (params.clipFromLocal * vec4f(ro + rd * tFar, 1.0)).w;
    }
    return vec4f(entry, exitD, 0.0, 1.0);
}
`;

/**
 * O passe. Um por material: ele é dono do pipeline (estático, compartilhado),
 * do uniform, do sampler e da LUT 1D da CTF.
 *
 * O alvo é uma VIEW de uma camada do array de profundidade — o chamador
 * escolhe o baseArrayLayer, e assim cada bisturi escreve na camada dele sem
 * mexer nas dos outros.
 */
export class ScalpelDepthPass {
    private static pipeline: GPURenderPipeline | null = null;
    private static layout: GPUBindGroupLayout | null = null;

    private readonly device: GPUDevice;
    private readonly paramsBuffer: GPUBuffer;
    private readonly sampler: GPUSampler;
    private readonly ctfLut: GPUTexture;

    constructor(device: GPUDevice) {
        this.device = device;
        //Params: 2 mat4 (128 bytes) + 5 f32. O struct arredonda pra 160.
        this.paramsBuffer = device.createBuffer({
            label: "ScalpelDepthPass params",
            size: 160,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.sampler = device.createSampler({
            label: "ScalpelDepthPass sampler",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            addressModeW: "clamp-to-edge",
        });
        this.ctfLut = device.createTexture({
            label: "ScalpelDepthPass ctf lut",
            size: [CTF_LUT_WIDTH, 1, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
    }

    private static getLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.layout) {
            this.layout = device.createBindGroupLayout({
                label: "ScalpelDepthPass layout",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                ],
            });
        }
        return this.layout;
    }

    private static getPipeline(device: GPUDevice): GPURenderPipeline {
        if (!this.pipeline) {
            const module = device.createShaderModule({
                label: "ScalpelDepthPass shader",
                code: SCALPEL_DEPTH_WGSL,
            });
            this.pipeline = device.createRenderPipeline({
                label: "ScalpelDepthPass",
                layout: device.createPipelineLayout({
                    bindGroupLayouts: [this.getLayout(device)],
                }),
                vertex: { module, entryPoint: "vs" },
                //rg32float: r = entrada da camada, g = saída. Renderável, e
                //lido depois com textureLoad (sem filtro) — assim não precisa
                //da feature float32-filterable, e de quebra interpolar
                //profundidade seria errado mesmo, que é a mesma regra dos
                //shadow maps.
                fragment: { module, entryPoint: "fs", targets: [{ format: "rg32float" }] },
                primitive: { topology: "triangle-list" },
            });
        }
        return this.pipeline;
    }

    /**
     * Carrega a LUT 1D de UMA CTF — a do bisturi que vai ser capturado agora, e
     * não a corrente da tela.
     *
     * Devolve o domínio da LUT, que o render precisa pra normalizar o HU. Vem
     * daqui e não do material de propósito: é o domínio DAQUELA CTF, e usar o
     * da CTF atual desalinharia a consulta.
     *
     * A textura é UMA só e é reescrita a cada bisturi, então o chamador tem que
     * submeter o encoder ANTES de chamar isto de novo — queue.writeTexture é
     * ordenado em relação aos submits, não aos passes dentro de um encoder. Um
     * encoder com N passes veria a última LUT escrita nos N.
     */
    setCtf(points: readonly CtfPoint[]): { huMin: number; huMax: number } {
        const baked = bakeCtfLut(points);
        this.device.queue.writeTexture(
            { texture: this.ctfLut },
            baked.data,
            { bytesPerRow: CTF_LUT_WIDTH * 4, rowsPerImage: 1 },
            [CTF_LUT_WIDTH, 1, 1],
        );
        return { huMin: baked.huMin, huMax: baked.huMax };
    }

    /**
     * Escreve o mapa de profundidade de UM bisturi na view dada (uma camada do
     * array). O `clipFromLocal` é o do bisturi; a inversa vem junto porque é
     * ela que desprojeta o pixel de volta pro volume.
     */
    render(
        encoder: GPUCommandEncoder,
        target: GPUTextureView,
        volumeTexture: GPUTexture,
        gradientTexture: GPUTexture,
        clipFromLocal: Mat4,
        inverseClipFromLocal: Mat4,
        ctfMin: number,
        ctfMax: number,
        thresholds: SurfaceThresholds,
    ): void {
        const data = new Float32Array(40);
        data.set(clipFromLocal, 0);
        data.set(inverseClipFromLocal, 16);
        data[32] = ctfMin;
        data[33] = ctfMax;
        data[34] = DEPTH_STEP;
        data[35] = thresholds.gradMin;
        data[36] = thresholds.alphaMin;
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);

        const bindGroup = this.device.createBindGroup({
            label: "ScalpelDepthPass bind group",
            layout: ScalpelDepthPass.getLayout(this.device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: gradientTexture.createView({ dimension: "3d" }) },
                { binding: 4, resource: this.ctfLut.createView() },
            ],
        });

        const pass = encoder.beginRenderPass({
            label: "ScalpelDepthPass",
            colorAttachments: [{
                view: target,
                //clear no sentinela: se o fragment nem rodar num pixel, ele já
                //fica valendo "sem superfície"
                //os DOIS canais nascem no sentinela
                clearValue: { r: NO_SURFACE, g: NO_SURFACE, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(ScalpelDepthPass.getPipeline(this.device));
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }

    destroy(): void {
        this.paramsBuffer.destroy();
        this.ctfLut.destroy();
    }
}
