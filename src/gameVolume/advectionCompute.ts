//Simulação de fumaça: ADVECÇÃO + EMISSOR (com ruído) + PROJEÇÃO + OBSTÁCULOS.
//
//Nomenclatura: FORÇA = field vetorial (velocidade, .xyz); FIELD = field escalar
//(densidade .r, divergência .r, pressão .r). "campo" fica pra field de classe TS.
//
//Pipeline por frame:
//  advecta+emite FORÇA (velA→velB)                     ← emissão modulada por ruído
//     → PROJEÇÃO (velB → velA, incompressível):
//         DIVERGÊNCIA → JACOBI ×N → SUBTRAI GRADIENTE   ← respeitando obstáculos
//  advecta+emite DENSIDADE (transportada por velA)
//
//OBSTÁCULOS (colisão): uma máscara r8unorm (1 = sólido) voxelizada dos AABBs das
//meshes estáticas (setObstacles). Ela entra na projeção como BC:
//  - JACOBI/GRADIENTE: vizinho sólido → usa a pressão da PRÓPRIA célula (Neumann,
//    ∂p/∂n=0). É isso que faz a pressão empilhar na parede e DESVIAR o fluxo.
//  - ADVECÇÃO: força E densidade são ZERADAS dentro do sólido (não-penetração +
//    fumaça não vaza pra dentro da pedra).
//  - DIVERGÊNCIA não precisa da máscara: como a força já é 0 no sólido, ela
//    enxerga fluxo nulo na parede de graça.
//
//div/pressão são r32float (só textureLoad, sem interpolar → não precisam ser
//filtráveis; f32 dá precisão pro solver). Velocidade/densidade seguem rgba16float.

const N_DEFAULT = 64;

//Ruído de valor (hash) 3D, pra a emissão turbulenta. In-shader, sem textura.
const NOISE_WGSL = /* wgsl */ `
fn hash13(p3in: vec3f) -> f32 {
    var p3 = fract(p3in * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
fn valueNoise(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let c000 = hash13(i + vec3f(0.0, 0.0, 0.0));
    let c100 = hash13(i + vec3f(1.0, 0.0, 0.0));
    let c010 = hash13(i + vec3f(0.0, 1.0, 0.0));
    let c110 = hash13(i + vec3f(1.0, 1.0, 0.0));
    let c001 = hash13(i + vec3f(0.0, 0.0, 1.0));
    let c101 = hash13(i + vec3f(1.0, 0.0, 1.0));
    let c011 = hash13(i + vec3f(0.0, 1.0, 1.0));
    let c111 = hash13(i + vec3f(1.0, 1.0, 1.0));
    let x00 = mix(c000, c100, u.x);
    let x10 = mix(c010, c110, u.x);
    let x01 = mix(c001, c101, u.x);
    let x11 = mix(c011, c111, u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
fn fbm(p: vec3f) -> f32 {
    return valueNoise(p) * 0.6
         + valueNoise(p * 2.03 + vec3f(11.1)) * 0.3
         + valueNoise(p * 4.01 + vec3f(23.3)) * 0.1;
}
`;

//--- Advector generalizado (transportador + carga), emissão com ruído, sólidos.
const ADVECT_WGSL = NOISE_WGSL + /* wgsl */ `
struct Params {
    gridSize   : vec3f,
    dt         : f32,
    emitCenter : vec3f,
    emitRadius : f32,
    emitAmount : vec4f,   // .xyz p/ força, .r p/ densidade
    emitNoise  : vec4f,   // x=time, y=noiseScale, z=contraste, w=dissipation
    frameVel   : vec4f,   // xyz = velocidade da CAIXA (células/s), subtraída do transporte
};
@group(0) @binding(0) var<uniform> params    : Params;
@group(0) @binding(1) var          linSampler: sampler;
@group(0) @binding(2) var          velocity  : texture_3d<f32>;                  // TRANSPORTADOR
@group(0) @binding(3) var          cargo     : texture_3d<f32>;                  // CARGA
@group(0) @binding(4) var          dstField  : texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var          obstacle  : texture_3d<f32>;                  // 1 = sólido

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let N = vec3u(params.gridSize);
    if (any(gid >= N)) { return; }
    let cell = vec3f(gid) + vec3f(0.5);

    // Transporte no referencial da CAIXA: subtrai a velocidade da caixa
    // (frameVel, células/s) → o conteúdo deriva pra trás quando a caixa anda —
    // é o rastro da locomotiva. Caixa parada → frameVel = 0, sem efeito.
    let u = textureLoad(velocity, vec3i(gid), 0).xyz - params.frameVel.xyz;
    let p  = cell - u * params.dt;
    let sp = p / params.gridSize;
    // Dissipação de MASSA: o transportado decai por emitNoise.w (densidade < 1;
    // velocidade = 1) → mantém a fumaça em regime estável em vez de acumular.
    var val = textureSampleLevel(cargo, linSampler, sp, 0.0) * params.emitNoise.w;

    // Emissão modulada por ruído 3D animado → fumaça grumosa/turbulenta.
    let np  = cell * params.emitNoise.y + vec3f(0.0, params.emitNoise.x * 0.6, params.emitNoise.x * 0.2);
    let n   = fbm(np);
    let noiseMod = mix(1.0 - params.emitNoise.z, 1.0 + params.emitNoise.z, n);
    let dist    = length(cell - params.emitCenter);
    let falloff = 1.0 - smoothstep(params.emitRadius * 0.5, params.emitRadius, dist);
    val += params.emitAmount * (falloff * params.dt * noiseMod);

    // Sólido: zera (não-penetração da força; densidade não entra na pedra).
    if (textureLoad(obstacle, vec3i(gid), 0).r > 0.5) {
        val = vec4f(0.0);
    }
    textureStore(dstField, vec3i(gid), val);
}
`;

//--- 1. DIVERGÊNCIA (força já é 0 no sólido → parede de graça). ----------------
const DIVERGENCE_WGSL = /* wgsl */ `
struct Params { gridSize : vec3f };
@group(0) @binding(0) var<uniform> params  : Params;
@group(0) @binding(1) var          velocity: texture_3d<f32>;
@group(0) @binding(2) var          divOut  : texture_storage_3d<r32float, write>;

fn velAt(p: vec3i, N: vec3i) -> vec3f {
    return textureLoad(velocity, clamp(p, vec3i(0), N - vec3i(1)), 0).xyz;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let N = vec3i(params.gridSize);
    let p = vec3i(gid);
    if (any(p >= N)) { return; }
    let R = velAt(p + vec3i(1, 0, 0), N).x;
    let L = velAt(p - vec3i(1, 0, 0), N).x;
    let T = velAt(p + vec3i(0, 1, 0), N).y;
    let B = velAt(p - vec3i(0, 1, 0), N).y;
    let F = velAt(p + vec3i(0, 0, 1), N).z;
    let D = velAt(p - vec3i(0, 0, 1), N).z;
    let div = 0.5 * ((R - L) + (T - B) + (F - D));
    textureStore(divOut, p, vec4f(div, 0.0, 0.0, 0.0));
}
`;

//--- 2. JACOBI com Neumann nos sólidos: vizinho sólido → pressão do centro. ----
const JACOBI_WGSL = /* wgsl */ `
struct Params { gridSize : vec3f };
@group(0) @binding(0) var<uniform> params     : Params;
@group(0) @binding(1) var          pressureIn : texture_3d<f32>;
@group(0) @binding(2) var          divergence : texture_3d<f32>;
@group(0) @binding(3) var          pressureOut: texture_storage_3d<r32float, write>;
@group(0) @binding(4) var          obstacle   : texture_3d<f32>;

fn pAt(p: vec3i, N: vec3i) -> f32 {
    return textureLoad(pressureIn, clamp(p, vec3i(0), N - vec3i(1)), 0).x;
}
fn solid(p: vec3i, N: vec3i) -> bool {
    return textureLoad(obstacle, clamp(p, vec3i(0), N - vec3i(1)), 0).x > 0.5;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let N = vec3i(params.gridSize);
    let p = vec3i(gid);
    if (any(p >= N)) { return; }
    let pC = pAt(p, N);
    // Vizinho sólido não "puxa" pressão: substitui pela do centro (Neumann).
    let pR = select(pAt(p + vec3i(1, 0, 0), N), pC, solid(p + vec3i(1, 0, 0), N));
    let pL = select(pAt(p - vec3i(1, 0, 0), N), pC, solid(p - vec3i(1, 0, 0), N));
    let pT = select(pAt(p + vec3i(0, 1, 0), N), pC, solid(p + vec3i(0, 1, 0), N));
    let pB = select(pAt(p - vec3i(0, 1, 0), N), pC, solid(p - vec3i(0, 1, 0), N));
    let pF = select(pAt(p + vec3i(0, 0, 1), N), pC, solid(p + vec3i(0, 0, 1), N));
    let pD = select(pAt(p - vec3i(0, 0, 1), N), pC, solid(p - vec3i(0, 0, 1), N));
    let div = textureLoad(divergence, p, 0).x;
    let pNew = (pR + pL + pT + pB + pF + pD - div) / 6.0;
    textureStore(pressureOut, p, vec4f(pNew, 0.0, 0.0, 0.0));
}
`;

//--- 3. SUBTRAI O GRADIENTE (Neumann nos sólidos; zera velocidade no sólido). --
const SUBTRACT_GRADIENT_WGSL = /* wgsl */ `
struct Params { gridSize : vec3f };
@group(0) @binding(0) var<uniform> params     : Params;
@group(0) @binding(1) var          velocityIn : texture_3d<f32>;
@group(0) @binding(2) var          pressure   : texture_3d<f32>;
@group(0) @binding(3) var          velocityOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var          obstacle   : texture_3d<f32>;

fn pAt(p: vec3i, N: vec3i) -> f32 {
    return textureLoad(pressure, clamp(p, vec3i(0), N - vec3i(1)), 0).x;
}
fn solid(p: vec3i, N: vec3i) -> bool {
    return textureLoad(obstacle, clamp(p, vec3i(0), N - vec3i(1)), 0).x > 0.5;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let N = vec3i(params.gridSize);
    let p = vec3i(gid);
    if (any(p >= N)) { return; }
    if (solid(p, N)) { textureStore(velocityOut, p, vec4f(0.0)); return; }
    let pC = pAt(p, N);
    let pR = select(pAt(p + vec3i(1, 0, 0), N), pC, solid(p + vec3i(1, 0, 0), N));
    let pL = select(pAt(p - vec3i(1, 0, 0), N), pC, solid(p - vec3i(1, 0, 0), N));
    let pT = select(pAt(p + vec3i(0, 1, 0), N), pC, solid(p + vec3i(0, 1, 0), N));
    let pB = select(pAt(p - vec3i(0, 1, 0), N), pC, solid(p - vec3i(0, 1, 0), N));
    let pF = select(pAt(p + vec3i(0, 0, 1), N), pC, solid(p + vec3i(0, 0, 1), N));
    let pD = select(pAt(p - vec3i(0, 0, 1), N), pC, solid(p - vec3i(0, 0, 1), N));
    let gradP = 0.5 * vec3f(pR - pL, pT - pB, pF - pD);
    let u = textureLoad(velocityIn, p, 0).xyz;
    textureStore(velocityOut, p, vec4f(u - gradP, 0.0));
}
`;

export class AdvectionSim {
    private readonly device: GPUDevice;
    readonly size: number;

    emitCenter: [number, number, number];
    emitRadius: number;
    densityRate = 4.0;
    jacobiIterations = 40;
    //Dissipação de MASSA (densidade) por segundo — mantém a quantidade de
    //fumaça em regime estável (emissão entra, dissipação sai). Força não dissipa.
    dissipationRate = 0.3;
    //Ruído da emissão: escala espacial (em coords de célula) e contraste (0..1).
    noiseScale = 0.25;
    noiseContrast = 0.85;

    private time = 0; //acumulado, pra animar o ruído da emissão

    private readonly velA: GPUTexture;
    private readonly velB: GPUTexture;
    private readonly velViewA: GPUTextureView;
    private readonly velViewB: GPUTextureView;
    private readonly densA: GPUTexture;
    private readonly densB: GPUTexture;
    private readonly densViewA: GPUTextureView;
    private readonly densViewB: GPUTextureView;
    private densCur: "A" | "B" = "A";
    private readonly divTex: GPUTexture;
    private readonly divView: GPUTextureView;
    private readonly presA: GPUTexture;
    private readonly presB: GPUTexture;
    private readonly presViewA: GPUTextureView;
    private readonly presViewB: GPUTextureView;
    //Máscara de obstáculo (1 = sólido). r8unorm, preenchida por setObstacles.
    private readonly obstacleTex: GPUTexture;
    private readonly obstacleView: GPUTextureView;

    private readonly sampler: GPUSampler;
    private readonly velParamsBuffer: GPUBuffer;
    private readonly densParamsBuffer: GPUBuffer;
    private readonly projParamsBuffer: GPUBuffer;
    private readonly velParamsData = new Float32Array(20);  //80 bytes (incl. emitNoise + frameVel)
    private readonly densParamsData = new Float32Array(20);

    private readonly advectPipeline: GPUComputePipeline;
    private readonly divergencePipeline: GPUComputePipeline;
    private readonly jacobiPipeline: GPUComputePipeline;
    private readonly subGradPipeline: GPUComputePipeline;

    private readonly bgVelAtoB: GPUBindGroup;
    private readonly bgDensAtoB: GPUBindGroup;
    private readonly bgDensBtoA: GPUBindGroup;
    private readonly bgDivergence: GPUBindGroup;
    private readonly bgJacobiAtoB: GPUBindGroup;
    private readonly bgJacobiBtoA: GPUBindGroup;
    private readonly bgSubGradFromA: GPUBindGroup;
    private readonly bgSubGradFromB: GPUBindGroup;

    constructor(device: GPUDevice, size: number = N_DEFAULT) {
        this.device = device;
        this.size = size;
        this.emitCenter = [size * 0.5, size * 0.12, size * 0.5];
        this.emitRadius = size * 0.1;

        const make = (label: string, format: GPUTextureFormat, usage: GPUTextureUsageFlags) =>
            device.createTexture({
                label: `advection ${label} (${size}^3)`,
                size: [size, size, size], dimension: "3d", format, usage,
            });
        const rw = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
        this.velA = make("vel A", "rgba16float", rw);
        this.velB = make("vel B", "rgba16float", rw);
        this.densA = make("dens A", "rgba16float", rw);
        this.densB = make("dens B", "rgba16float", rw);
        this.divTex = make("divergence", "r32float", rw);
        this.presA = make("pressure A", "r32float", rw);
        this.presB = make("pressure B", "r32float", rw);
        //máscara: amostrável (textureLoad) + destino de writeTexture.
        this.obstacleTex = make("obstacle", "r8unorm", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
        const view = (t: GPUTexture) => t.createView({ dimension: "3d" });
        this.velViewA = view(this.velA); this.velViewB = view(this.velB);
        this.densViewA = view(this.densA); this.densViewB = view(this.densB);
        this.divView = view(this.divTex);
        this.presViewA = view(this.presA); this.presViewB = view(this.presB);
        this.obstacleView = view(this.obstacleTex);

        this.sampler = device.createSampler({
            label: "advection sampler",
            magFilter: "linear", minFilter: "linear",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge",
        });

        const mkBuf = (label: string, bytes: number) =>
            device.createBuffer({ label, size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.velParamsBuffer = mkBuf("advection vel params", 80);
        this.densParamsBuffer = mkBuf("advection dens params", 80);
        this.projParamsBuffer = mkBuf("advection proj params", 16);
        const initAdvectConst = (d: Float32Array) => {
            d[0] = size; d[1] = size; d[2] = size;                                  //gridSize
            d[4] = this.emitCenter[0]; d[5] = this.emitCenter[1]; d[6] = this.emitCenter[2];
            d[7] = this.emitRadius;
            d[13] = this.noiseScale; d[14] = this.noiseContrast;                    //emitNoise.y,.z
        };
        initAdvectConst(this.velParamsData);
        initAdvectConst(this.densParamsData);
        device.queue.writeBuffer(this.velParamsBuffer, 0, this.velParamsData);
        device.queue.writeBuffer(this.densParamsBuffer, 0, this.densParamsData);
        device.queue.writeBuffer(this.projParamsBuffer, 0, new Float32Array([size, size, size, 0]));

        const uni = { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } };
        const tex = (binding: number, sampleType: GPUTextureSampleType) =>
            ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType, viewDimension: "3d" as const } });
        const storage = (binding: number, format: GPUTextureFormat) =>
            ({ binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { format, viewDimension: "3d" as const } });

        const advectLayout = device.createBindGroupLayout({
            label: "advect",
            entries: [uni,
                { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
                tex(2, "float"), tex(3, "float"), storage(4, "rgba16float"), tex(5, "float")],
        });
        const divergenceLayout = device.createBindGroupLayout({
            label: "divergence",
            entries: [uni, tex(1, "float"), storage(2, "r32float")],
        });
        const jacobiLayout = device.createBindGroupLayout({
            label: "jacobi",
            entries: [uni, tex(1, "unfilterable-float"), tex(2, "unfilterable-float"), storage(3, "r32float"), tex(4, "float")],
        });
        const subGradLayout = device.createBindGroupLayout({
            label: "subtract gradient",
            entries: [uni, tex(1, "float"), tex(2, "unfilterable-float"), storage(3, "rgba16float"), tex(4, "float")],
        });

        const pipe = (label: string, code: string, layout: GPUBindGroupLayout) =>
            device.createComputePipeline({
                label,
                layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
            });
        this.advectPipeline = pipe("advect", ADVECT_WGSL, advectLayout);
        this.divergencePipeline = pipe("divergence", DIVERGENCE_WGSL, divergenceLayout);
        this.jacobiPipeline = pipe("jacobi", JACOBI_WGSL, jacobiLayout);
        this.subGradPipeline = pipe("subtract gradient", SUBTRACT_GRADIENT_WGSL, subGradLayout);

        const bg = (label: string, layout: GPUBindGroupLayout, resources: GPUBindingResource[]) =>
            device.createBindGroup({ label, layout, entries: resources.map((resource, binding) => ({ binding, resource })) });

        this.bgVelAtoB = bg("advect vel A->B", advectLayout,
            [{ buffer: this.velParamsBuffer }, this.sampler, this.velViewA, this.velViewA, this.velViewB, this.obstacleView]);
        this.bgDensAtoB = bg("advect dens A->B", advectLayout,
            [{ buffer: this.densParamsBuffer }, this.sampler, this.velViewA, this.densViewA, this.densViewB, this.obstacleView]);
        this.bgDensBtoA = bg("advect dens B->A", advectLayout,
            [{ buffer: this.densParamsBuffer }, this.sampler, this.velViewA, this.densViewB, this.densViewA, this.obstacleView]);
        this.bgDivergence = bg("divergence", divergenceLayout,
            [{ buffer: this.projParamsBuffer }, this.velViewB, this.divView]);
        this.bgJacobiAtoB = bg("jacobi A->B", jacobiLayout,
            [{ buffer: this.projParamsBuffer }, this.presViewA, this.divView, this.presViewB, this.obstacleView]);
        this.bgJacobiBtoA = bg("jacobi B->A", jacobiLayout,
            [{ buffer: this.projParamsBuffer }, this.presViewB, this.divView, this.presViewA, this.obstacleView]);
        this.bgSubGradFromA = bg("subgrad from A", subGradLayout,
            [{ buffer: this.projParamsBuffer }, this.velViewB, this.presViewA, this.velViewA, this.obstacleView]);
        this.bgSubGradFromB = bg("subgrad from B", subGradLayout,
            [{ buffer: this.projParamsBuffer }, this.velViewB, this.presViewB, this.velViewA, this.obstacleView]);
    }

    /**
     * Voxeliza os obstáculos na máscara (1 = sólido). `boxes` em coordenadas de
     * CÉLULA do grid (o mundo faz o mapeamento mundo→célula). Estáticos: chame
     * uma vez. Sem chamada, a máscara fica zerada (sem obstáculos).
     */
    setObstacles(boxes: { min: [number, number, number]; max: [number, number, number] }[]): void {
        const N = this.size;
        const data = new Uint8Array(N * N * N);
        for (const b of boxes) {
            const x0 = Math.max(0, Math.floor(b.min[0])), x1 = Math.min(N - 1, Math.ceil(b.max[0]));
            const y0 = Math.max(0, Math.floor(b.min[1])), y1 = Math.min(N - 1, Math.ceil(b.max[1]));
            const z0 = Math.max(0, Math.floor(b.min[2])), z1 = Math.min(N - 1, Math.ceil(b.max[2]));
            for (let z = z0; z <= z1; z++) {
                for (let y = y0; y <= y1; y++) {
                    const row = (z * N + y) * N;
                    for (let x = x0; x <= x1; x++) {
                        data[row + x] = 255;
                    }
                }
            }
        }
        this.device.queue.writeTexture(
            { texture: this.obstacleTex }, data,
            { bytesPerRow: N, rowsPerImage: N }, [N, N, N],
        );
    }

    step(
        encoder: GPUCommandEncoder,
        dt: number,
        velEmit: [number, number, number],
        frameVel: [number, number, number],
    ): void {
        this.time += dt;
        //Força: emite velEmit, NÃO dissipa (w=1), transporta no frame da caixa.
        this.velParamsData[3] = dt;
        this.velParamsData[8] = velEmit[0]; this.velParamsData[9] = velEmit[1];
        this.velParamsData[10] = velEmit[2]; this.velParamsData[11] = 0;
        this.velParamsData[12] = this.time; this.velParamsData[15] = 1.0;
        this.velParamsData[16] = frameVel[0]; this.velParamsData[17] = frameVel[1]; this.velParamsData[18] = frameVel[2];
        //Densidade: emite densityRate, DISSIPA (w<1), mesmo frame da caixa.
        this.densParamsData[3] = dt;
        this.densParamsData[8] = this.densityRate; this.densParamsData[9] = 0;
        this.densParamsData[10] = 0; this.densParamsData[11] = 0;
        this.densParamsData[12] = this.time;
        this.densParamsData[15] = Math.max(0, 1 - this.dissipationRate * dt);
        this.densParamsData[16] = frameVel[0]; this.densParamsData[17] = frameVel[1]; this.densParamsData[18] = frameVel[2];
        this.device.queue.writeBuffer(this.velParamsBuffer, 0, this.velParamsData);
        this.device.queue.writeBuffer(this.densParamsBuffer, 0, this.densParamsData);

        const g = Math.ceil(this.size / 4);
        const one = (label: string, pipeline: GPUComputePipeline, group: GPUBindGroup) => {
            const pass = encoder.beginComputePass({ label });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(g, g, g);
            pass.end();
        };

        //1. Força se auto-advecta + emissão (velA→velB).
        one("advect velocity", this.advectPipeline, this.bgVelAtoB);

        //2. PROJEÇÃO de velB → velA.
        one("divergence", this.divergencePipeline, this.bgDivergence);
        const iters = this.jacobiIterations;
        for (let i = 0; i < iters; i++) {
            one(`jacobi ${i}`, this.jacobiPipeline, i % 2 === 0 ? this.bgJacobiAtoB : this.bgJacobiBtoA);
        }
        const finalInA = iters % 2 === 0;
        one("subtract gradient", this.subGradPipeline, finalInA ? this.bgSubGradFromA : this.bgSubGradFromB);

        //3. Densidade advectada pela força projetada (velA) + emissão.
        const a = this.densCur === "A";
        one("advect density", this.advectPipeline, a ? this.bgDensAtoB : this.bgDensBtoA);
        this.densCur = a ? "B" : "A";
    }

    get densityView(): GPUTextureView {
        return this.densCur === "A" ? this.densViewA : this.densViewB;
    }

    destroy(): void {
        this.velA.destroy(); this.velB.destroy();
        this.densA.destroy(); this.densB.destroy();
        this.divTex.destroy();
        this.presA.destroy(); this.presB.destroy();
        this.obstacleTex.destroy();
        this.velParamsBuffer.destroy();
        this.densParamsBuffer.destroy();
        this.projParamsBuffer.destroy();
    }
}
