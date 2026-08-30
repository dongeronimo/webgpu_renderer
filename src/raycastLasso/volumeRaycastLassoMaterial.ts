//Material do RAYCASTER DO LASSO. Clone do VolumeRaycastESSMaterial
//(../raycastESS/) — MESMO raymarch single-pass proxy-cube, MESMA CTF
//pré-integrada (Engel), MESMO shading por gradiente, MESMO empty-space skipping
//por chunk. É o material de um WORLD NOVO de propósito: o ESS fica intacto como
//baseline de qualidade/velocidade (A/B no gpuTimer), e o corte por lasso é
//experimentado aqui sem risco pra ele.
//
//O QUE O LASSO ACRESCENTA ao laço (procure por "LASSO:" no fragment):
//
//  1. Um lasso = contorno em NDC + a câmera CONGELADA do instante do desenho,
//     já composta em clipFromLocal (proj·view·model): pLocal ([-0.5,0.5]³) →
//     clip daquele lasso. Guardar a MATRIZ (e não um vetor de direção) é o que
//     faz o sólido removido ser a PIRÂMIDE infinita que o usuário viu na tela,
//     e não um prisma que só coincide com o traço no centro da imagem.
//  2. O teste dentro/fora é um fetch: o contorno vira uma máscara rasterizada
//     na CPU (lassoMask.ts), uma camada do texture_2d_array por lasso. Custo
//     fixo, sem branch divergente — varrer os segmentos por amostra seria
//     dezenas de milhares de testes por pixel.
//  3. Descarta-se o SEGMENTO, não a amostra: o laço lê sf em uvw e sb em
//     uvw+rd*step e indexa T[sf][sb]. Cortar só uma das pontas indexaria um par
//     que não existe mais — faixa de cor errada na borda do corte. Por isso o
//     ponto de teste é o MÉDIO do segmento.
//  4. O teste vem ANTES de amostrar: dentro de um lasso, o segmento nem chega a
//     custar as leituras do volume, a CTF e as 6 fetches do gradiente.
//
//params.lassoDebug troca o corte pela PINTURA da mesma região (magenta) — é a
//debug view das máscaras, e o único jeito de conferir a matriz sem que o que
//você quer olhar desapareça da tela.
//
//Bind groups: iguais aos do ESS (grupos 0/1 do frame/objeto; grupo 2 material
//com params/sampler/volume/preint/gradient/skip-map). Só aceita MeshType.Static
//(o proxy-cube).
import { bakePreIntegrationTable, PREINT_TABLE_SIZE, type CtfPoint } from "../ctf";
import { Material, type PipelineContext } from "../material";
import { MeshType, StaticMesh } from "../mesh";
import type { LassoData } from "./lassoData";
import { CONTOUR_MASK_SIZE, rasterizeContourMask } from "./contourMask";
import type { ScalpelData } from "./scalpelData";
import { DEFAULT_SURFACE_THRESHOLDS, ScalpelDepthPass, SCALPEL_DEPTH_SIZE } from "./scalpelDepthPass";
import { mat4 } from "wgpu-matrix";

const DEFAULT_STEP_SIZE = 1 / 256;

/** Grade de chunks + lado do chunk, tudo vindo do metadata do exame. */
export interface ChunkGrid {
    numChunksX: number;
    numChunksY: number;
    numChunksZ: number;
    totalChunks: number;
    /** Lado do chunk cúbico em VOXELS. */
    chunkSize: number;
}

const RAYCAST_LASSO_WGSL = /* wgsl */ `
struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> models: array<mat4x4f>;

struct Params {
    ctfMin: f32,       //HU do primeiro ponto da CTF (início do domínio)
    ctfMax: f32,       //HU do último ponto (fim do domínio)
    alphaScale: f32,   //dilui a opacidade da CTF por passo (knob da UI)
    stepSize: f32,     //passo local ao longo do raio (espaço da caixa)
    //---
    useGradient: f32,  //>0.5 usa gradiente, else cor chapada
    gradientType: f32, //>0.5 = on-the-fly, else pré-calculado
    useSkip: f32,      //>0.5 liga o empty-space skipping (else marcha tudo)
    chunkSize: f32,    //lado do chunk em VOXELS
    //---
    spacing: vec3f,    //mm por voxel em x,y,z (vec3f alinha em 16 → offset 32)
    //Os dois campos abaixo ocupam o PADDING dos vec3f (offsets 44 e 60): vec3f
    //tem tamanho 12 e alinhamento 16, então um f32 logo depois entra no buraco
    //de graça — o uniform continua com 64 bytes.
    lassoCount: f32,   //quantos lassos vigentes (offset 44)
    //---
    numChunks: vec3f,  //nº de chunks por eixo (f32 → u32 no shader; offset 48)
    lassoDebug: f32,   //>0.5 PINTA a região dos lassos em vez de cortar (offset 60)
    //---
    scalpelCount: f32, //quantos bisturis vigentes (offset 64)
    scalpelDebug: f32, //>0.5 PINTA a casca do bisturi em vez de cortar (offset 68)
};
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var samp: sampler;
@group(2) @binding(2) var volume: texture_3d<f32>;
@group(2) @binding(3) var preint: texture_2d<f32>; //tabela pré-integrada T[sf][sb]
@group(2) @binding(4) var gradient: texture_3d<f32>; //o gradiente pré-calculado
@group(2) @binding(5) var<storage, read> occupied: array<u32>; //skip-map: 1=processa, 0=pula
//As máscaras dos lassos, uma CAMADA por lasso (r8unorm: 255 dentro, 0 fora),
//rasterizadas na CPU quando a lista muda — ver lassoMask.ts.
@group(2) @binding(6) var lassoMasks: texture_2d_array<f32>;
//A câmera congelada de cada lasso, na MESMA ordem das camadas: leva pLocal
//direto pro clip daquele lasso (proj·view·model, composta na CPU).
@group(2) @binding(7) var<storage, read> lassoClip: array<mat4x4f>;

//---- BISTURI: recursos PRÓPRIOS, deliberadamente separados dos do lasso -----
//As duas ferramentas se parecem (contorno + câmera congelada) mas produzem
//coisas diferentes: o lasso fura de ponta a ponta, o bisturi descasca uma
//camada. Compartilhar os buffers economizaria pouco e amarraria as duas — uma
//mudança no lasso passaria a poder quebrar o corte por profundidade.
@group(2) @binding(8) var scalpelMasks: texture_2d_array<f32>;
struct Scalpel {
    clipFromLocal: mat4x4f,
    //MARGEM em unidades de mundo: o quanto remover ALÉM do fim da camada. A
    //espessura do corte não vem daqui — vem do mapa, que mede onde a estrutura
    //acaba em cada pixel. Zero é o valor normal.
    margin: f32,
};
@group(2) @binding(9) var<storage, read> scalpels: array<Scalpel>;
//O mapa da CAMADA, capturado quando o bisturi foi feito (ScalpelDepthPass):
//R = onde o material começa, G = onde ACABA, por pixel. É o G que dá noção de
//estrutura ao corte — sem ele a casca teria espessura fixa e truncaria em
//cotoco tudo que é curvo. rg32float, lido com textureLoad e SEM filtro: além
//de dispensar a feature float32-filterable, interpolar profundidade através de
//uma silhueta daria um valor que não existe em lugar nenhum — a mesma regra
//que vale pra shadow map.
@group(2) @binding(10) var scalpelDepths: texture_2d_array<f32>;

const REFERENCE_SLICE_COUNT: f32 = 128.0;
const MAX_STEPS: i32 = 512;
//Nudge pra o salto de skip pousar DENTRO do próximo chunk (senão pode reler o
//mesmo e travar). Em unidades de t (rd é normalizado no espaço local, caixa=1).
const SKIP_EPS: f32 = 1e-4;

//Cor do debug das máscaras: magenta, que não existe em CT nenhuma — cinza de
//tecido e branco de osso nunca vão ser confundidos com ela.
const LASSO_DEBUG_TINT = vec3f(1.0, 0.15, 0.55);

//O ponto (espaço LOCAL do volume) cai dentro de algum lasso?
//
//Projeta com a matriz congelada daquele lasso e consulta a máscara. Sem
//hoisting de A/B pra fora do laço de propósito: com N dinâmico, os A/B
//viveriam num array de tamanho fixo indexado dinamicamente, que a GPU joga em
//memória privada (spill) — sairia mais caro que refazer a mat4×vec4 aqui.
fn insideAnyLasso(pLocal: vec3f, count: u32) -> bool {
    for (var i = 0u; i < count; i = i + 1u) {
        let c = lassoClip[i] * vec4f(pLocal, 1.0);
        //Atrás do olho congelado: projeta espelhado, cairia no polígono errado.
        if (c.w <= 0.0) {
            continue;
        }
        //NDC → uv, com o y invertido (NDC cresce pra cima, v cresce pra baixo).
        //Fora de [0,1] o clamp-to-edge devolve o anel de borda, que a
        //rasterização zera de propósito — ou seja, "fora".
        let uv = vec2f(c.x / c.w, -c.y / c.w) * 0.5 + vec2f(0.5);
        //textureSampleLevel (LOD explícito) é válido em fluxo não-uniforme;
        //textureSample não seria, e este "if" é exatamente isso.
        if (textureSampleLevel(lassoMasks, samp, uv, i, 0.0).r > 0.5) {
            return true;
        }
    }
    return false;
}

//Verde-piscina: a segunda ferramenta precisa de uma cor que não se confunda
//com o magenta do lasso nem com nada que exista numa CT. São DUAS: a clara
//marca onde a superfície foi DETECTADA, a escura o fundo da casca. Assim a
//debug view não diz só "aqui vai sumir" — diz onde o mapa de profundidade
//acha que está a pele, que é a parte que dá errado em silêncio.
const SCALPEL_SURFACE_TINT = vec3f(0.75, 1.0, 0.96);
const SCALPEL_DEBUG_TINT = vec3f(0.0, 0.72, 0.66);
//Opacidade MÍNIMA das amostras pintadas na debug view.
//
//Sem isto o debug do bisturi é invisível, e a razão é sutil: o tint mexe na
//COR, mas o peso da contribuição sai do aRef, que é a opacidade que a CTF dá
//àquela amostra. O lasso se safa porque pinta um trecho longo do raio e soma
//até aparecer; a casca do bisturi tem uns 5% do raio e frequentemente cai em
//tecido que a CTF atual quase não mostra — pintar sem forçar alpha é pintar no
//vidro. Só vale com a debug view ligada: no corte de verdade nada disso roda.
const SCALPEL_DEBUG_MIN_ALPHA: f32 = 0.22;
//Bias pra FRENTE da superfície. A profundidade guardada e a posição das
//amostras vêm de marchas diferentes (resoluções e passos diferentes), então
//sem folga o corte começa um tiquinho tarde e sobra uma casquinha flutuando —
//o peter-panning dos shadow maps. Errar pra frente remove um fio de ar, que
//não se vê; errar pra trás deixa sujeira na tela.
const SCALPEL_BIAS: f32 = 0.005;
//O passe grava 1e30 onde o raio não achou superfície. Qualquer coisa acima
//deste corte conta como "não achou".
const SCALPEL_NO_SURFACE: f32 = 1e29;

//O ponto cai dentro da CASCA de algum bisturi?
//
//É o teste do lasso MAIS a comparação de profundidade — e é exatamente essa
//comparação a mais que transforma a pirâmide infinita numa casca que segue o
//relevo. Sem ela (lasso), todo ponto da reta olho→pixel tem a mesma resposta;
//com ela, só a faixa [entrada, saída+margem] responde sim — e essa faixa tem a
//espessura DA ESTRUTURA naquele pixel, não uma espessura escolhida no slider.
fn scalpelShellRatio(pLocal: vec3f, count: u32) -> f32 {
    for (var i = 0u; i < count; i = i + 1u) {
        let sc = scalpels[i];
        let c = sc.clipFromLocal * vec4f(pLocal, 1.0);
        //Atrás do olho congelado: projetaria espelhado.
        if (c.w <= 0.0) {
            continue;
        }
        let uv = vec2f(c.x / c.w, -c.y / c.w) * 0.5 + vec2f(0.5);
        //Fora do contorno desenhado: nem olha a profundidade.
        if (textureSampleLevel(scalpelMasks, samp, uv, i, 0.0).r <= 0.5) {
            continue;
        }
        //uv → texel, pro textureLoad (sem sampler, sem filtro).
        let dims = vec2f(textureDimensions(scalpelDepths));
        let texel = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
        //R = entrada da camada, G = saída. Os dois no mesmo texel, capturados
        //na mesma marcha — então não há como um estar de um lasso e outro de
        //outro.
        let layer = textureLoad(scalpelDepths, texel, i, 0).rg;
        let dEnter = layer.r;
        //Raio que só atravessou ar: não há camada nenhuma pra remover aqui.
        if (dEnter >= SCALPEL_NO_SURFACE) {
            continue;
        }
        //O fim do corte é o fim da ESTRUTURA, mais a margem do usuário.
        let dExit = layer.g + sc.margin;
        //c.w é a profundidade LINEAR na câmera congelada — a mesma unidade em
        //que o mapa foi gravado.
        if (c.w >= dEnter - SCALPEL_BIAS && c.w <= dExit) {
            //ONDE na camada: 0 = na superfície detectada, 1 = no fim dela. O
            //corte ignora esse número (dentro é dentro); quem o usa é a debug
            //view, pra separar as duas coisas visualmente.
            return clamp((c.w - dEnter) / max(dExit - dEnter, 1e-6), 0.0, 1.0);
        }
    }
    //Negativo = fora de toda casca. Sentinela e não bool porque o valor de
    //dentro carrega informação que o debug precisa.
    return -1.0;
}

struct VsOut {
    @builtin(position) position: vec4f,
    @location(0) localPos: vec3f,
    @location(1) @interpolate(flat) instance: u32,
};

@vertex
fn vs(
    @location(0) position: vec3f,
    @builtin(instance_index) instance: u32,
) -> VsOut {
    var out: VsOut;
    out.position = frame.proj * frame.view * models[instance] * vec4f(position, 1.0);
    out.localPos = position;
    out.instance = instance;
    return out;
}

fn inverse3(m: mat3x3f) -> mat3x3f {
    let a = m[0];
    let b = m[1];
    let c = m[2];
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

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let model = models[in.instance];
    let R = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
    let camWorld = -(transpose(R) * frame.view[3].xyz);
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
    let tFar = min(min(tbig.x, tbig.y), tbig.z);
    tNear = max(tNear, 0.0);
    if (tFar <= tNear) {
        discard;
    }

    let step = params.stepSize;
    let opacityExponent = step * REFERENCE_SLICE_COUNT;
    let range = max(params.ctfMax - params.ctfMin, 1e-6);

    let voxel = 1.0 / vec3f(textureDimensions(volume));
    let lightPos = vec3f(5.0, 5.0, 5.0);
    let normalMatrix = transpose(invLin);

    //ESS: hoisted pra fora do laço (uniformes). chunkCell = tamanho do chunk em
    //uvw por eixo = chunkSize(voxels)/dims(voxels). O último chunk de um eixo
    //pode ser parcial (numChunks*chunkSize >= dim) — o tFar da caixa grande já
    //corta o excesso, então não precisa clamp no salto.
    let chunkCell = vec3f(params.chunkSize) / vec3f(textureDimensions(volume));
    let nChunks = vec3u(u32(params.numChunks.x), u32(params.numChunks.y), u32(params.numChunks.z));
    let nChunksMax = vec3f(nChunks) - vec3f(1.0);
    //uniformes: saem do laço
    let lassoCount = u32(params.lassoCount);
    let scalpelCount = u32(params.scalpelCount);

    var acc = vec4f(0.0);
    var t = tNear;
    for (var i = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= tFar) {
            break;
        }
        let pLocal = camLocal + rd * t;
        let uvw = pLocal + vec3f(0.5);

        //EMPTY-SPACE SKIPPING: chunk vazio pra CTF atual → salta pra saída da
        //caixa DESTE chunk em vez de amostrar. cidxF (não-clampado) constrói o
        //AABB; ci (clampado) indexa o skip-map sem estourar a borda.
        if (params.useSkip > 0.5) {
            let cidxF = floor(uvw / chunkCell);
            let ci = vec3u(clamp(cidxF, vec3f(0.0), nChunksMax));
            let flat = (ci.z * nChunks.y + ci.y) * nChunks.x + ci.x;
            if (occupied[flat] == 0u) {
                let loLocal = cidxF * chunkCell - vec3f(0.5);
                let hiLocal = loLocal + chunkCell;
                let tLo = (loLocal - camLocal) * invD;
                let tHi = (hiLocal - camLocal) * invD;
                let tExit = min(min(max(tLo.x, tHi.x), max(tLo.y, tHi.y)), max(tLo.z, tHi.z));
                t = tExit + SKIP_EPS;
                continue;
            }
        }

        //LASSO: dentro de algum lasso, este segmento não existe.
        //
        //O teste vem AQUI, antes de qualquer amostragem, porque cortar depois
        //seria pagar as duas leituras do volume, a CTF pré-integrada e o bloco
        //do gradiente (6 fetches no modo on-the-fly) pra jogar tudo fora. Só
        //perde pro skip-map, que é uma leitura de storage e ainda salta o chunk
        //inteiro — por isso ele vem antes.
        //
        //Ponto MÉDIO do segmento: o par (sf,sb) da CTF pré-integrada descreve o
        //segmento inteiro, então ou ele todo entra ou ele todo sai.
        var lassoHit = false;
        if (lassoCount > 0u) {
            lassoHit = insideAnyLasso(pLocal + rd * (step * 0.5), lassoCount);
            //O CORTE. Com a debug view ligada não corta: cai fora do if e o
            //segmento segue o caminho normal pra ser PINTADO lá embaixo.
            if (lassoHit && params.lassoDebug <= 0.5) {
                t = t + step;
                continue;
            }
        }

        //SCALPEL: bloco PRÓPRIO, e não um "modo" do lasso. O teste é outro
        //(reprojeta, consulta a máscara E compara profundidade) e o resultado é
        //outro (casca, não furo). A duplicação da reprojeção é de propósito: as
        //duas ferramentas evoluem separadas, e mexer numa não pode quebrar a
        //outra. Vem DEPOIS do lasso porque custa mais — o lasso decide com um
        //fetch, o bisturi com dois.
        var scalpelShell = -1.0;
        if (scalpelCount > 0u) {
            scalpelShell = scalpelShellRatio(pLocal + rd * (step * 0.5), scalpelCount);
            if (scalpelShell >= 0.0 && params.scalpelDebug <= 0.5) {
                t = t + step;
                continue;
            }
        }

        let sf = textureSampleLevel(volume, samp, uvw, 0.0).r;
        let sb = textureSampleLevel(volume, samp, uvw + rd * step, 0.0).r;
        let uf = (sf - params.ctfMin) / range;
        let ub = (sb - params.ctfMin) / range;
        let c = textureSampleLevel(preint, samp, vec2f(uf, ub), 0.0);

        var rgb = c.rgb;
        if (params.useGradient > 0.5) {
            var gLocal = vec3f(0,0,0);
            if(params.gradientType > 0.5) {
                let gx = (textureSampleLevel(volume, samp, uvw + vec3f(voxel.x, 0.0, 0.0), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(voxel.x, 0.0, 0.0), 0.0).r) / (2.0 * params.spacing.x);
                let gy = (textureSampleLevel(volume, samp, uvw + vec3f(0.0, voxel.y, 0.0), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(0.0, voxel.y, 0.0), 0.0).r) / (2.0 * params.spacing.y);
                let gz = (textureSampleLevel(volume, samp, uvw + vec3f(0.0, 0.0, voxel.z), 0.0).r
                       -  textureSampleLevel(volume, samp, uvw - vec3f(0.0, 0.0, voxel.z), 0.0).r) / (2.0 * params.spacing.z);
                gLocal = vec3f(gx, gy, gz);
            }
            else {
                let dHU = textureSampleLevel(gradient, samp, uvw, 0.0);
                gLocal = dHU.xyz * 2.0 - 1.0;
            }

            if (length(gLocal) > 0.001) {
                let N = normalize(normalMatrix * (-gLocal));
                let pWorld = (model * vec4f(pLocal, 1.0)).xyz;
                let L = normalize(lightPos - pWorld);
                let V = normalize(camWorld - pWorld);
                let H = normalize(L + V);
                let diffuse = max(dot(N, L), 0.0);
                let specular = pow(max(dot(N, H), 0.0), 32.0);
                let ambient = 0.2;
                rgb = c.rgb * (ambient + (1.0 - ambient) * diffuse) + vec3f(0.3 * specular);
            }
        }

        //LASSO (debug view): pinta o que o corte teria removido. lassoHit só
        //chega aqui verdadeiro com a debug view ligada — sem ela, o segmento já
        //teria dado continue lá em cima.
        if (lassoHit) {
            rgb = mix(rgb, LASSO_DEBUG_TINT, 0.75);
        }
        var aRef = clamp(c.a * params.alphaScale, 0.0, 1.0);
        //BISTURI (debug view): pinta a casca e FORÇA um alpha mínimo. Aqui,
        //depois do aRef, e não junto do tint do lasso, justamente porque
        //precisa mexer na opacidade — pintar só a cor deixaria a casca
        //invisível em tecido que a CTF atual não mostra.
        //
        //Claro na superfície detectada, escurecendo até o fim do descasque: o
        //degradê é o que deixa ver, de uma olhada, se o mapa de profundidade
        //pousou na pele ou flutuando.
        if (scalpelShell >= 0.0) {
            rgb = mix(SCALPEL_SURFACE_TINT, SCALPEL_DEBUG_TINT, scalpelShell);
            aRef = max(aRef, SCALPEL_DEBUG_MIN_ALPHA);
        }
        let alpha = 1.0 - pow(1.0 - aRef, opacityExponent);
        let w = (1.0 - acc.a) * alpha;
        acc = vec4f(acc.rgb + w * rgb, acc.a + w);
        if (acc.a >= 0.995) {
            break;
        }
        t = t + step;
    }
    return acc;
}
`;

export class VolumeRaycastLassoMaterial extends Material {
    private static shaderModule: GPUShaderModule | null = null;
    private static materialLayout: GPUBindGroupLayout | null = null;
    private static sampler: GPUSampler | null = null;
    private static pipeline: GPURenderPipeline | null = null;

    private static getMaterialBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
        if (!this.materialLayout) {
            this.materialLayout = device.createBindGroupLayout({
                label: "VolumeRaycastLassoMaterial material",
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
                    //o skip-map: storage read-only no fragment (igual aos models do grupo 1)
                    { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                    //máscaras dos lassos (1 camada por lasso) + as matrizes congeladas
                    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
                    { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                    //bisturi: máscaras + (matriz, espessura) + mapas de profundidade.
                    //O r32float é "unfilterable-float" porque é lido com
                    //textureLoad — sem isso a validação exigiria a feature
                    //float32-filterable só pra um sampler que não se usa.
                    { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
                    { binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                    { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
                ],
            });
        }
        return this.materialLayout;
    }

    private static getSampler(device: GPUDevice): GPUSampler {
        if (!this.sampler) {
            this.sampler = device.createSampler({
                label: "VolumeRaycastLassoMaterial sampler",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
                addressModeW: "clamp-to-edge",
            });
        }
        return this.sampler;
    }

    private static createPipeline(ctx: PipelineContext): GPURenderPipeline {
        const { device } = ctx;
        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({
                label: "VolumeRaycastLassoMaterial shader",
                code: RAYCAST_LASSO_WGSL,
            });
        }
        return device.createRenderPipeline({
            label: "VolumeRaycastLassoMaterial (Static)",
            layout: device.createPipelineLayout({
                label: "VolumeRaycastLassoMaterial pipeline layout",
                bindGroupLayouts: [
                    ctx.frameBindGroupLayout,
                    ctx.objectBindGroupLayout,
                    this.getMaterialBindGroupLayout(device),
                ],
            }),
            vertex: {
                module: this.shaderModule,
                entryPoint: "vs",
                buffers: [StaticMesh.vertexLayout],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: ctx.colorFormat,
                        blend: {
                            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "front" },
            depthStencil: {
                format: ctx.depthFormat,
                depthWriteEnabled: false,
                depthCompare: "less-equal",
            },
        });
    }

    private readonly device: GPUDevice;
    private readonly volumeTexture: GPUTexture;
    private readonly preintTexture: GPUTexture;
    private readonly gradientTexture: GPUTexture;
    private readonly paramsBuffer: GPUBuffer;
    //o skip-map (1 u32/chunk); a CPU o preenche via setSkipMap
    private readonly occupiedBuffer: GPUBuffer;
    //Os recursos dos lassos são RECRIADOS a cada mudança da lista (o número de
    //camadas de um texture_2d_array é fixo na criação), e por isso o bind group
    //também é — nada disso pode ser readonly.
    private lassoMaskTexture!: GPUTexture;
    private lassoClipBuffer!: GPUBuffer;
    //Bisturi: mesma dança de recriação, mais o mapa de profundidade e o passe
    //que o preenche.
    private scalpelMaskTexture!: GPUTexture;
    private scalpelBuffer!: GPUBuffer;
    private scalpelDepthTexture!: GPUTexture;
    private readonly depthPass: ScalpelDepthPass;
    private bindGroup!: GPUBindGroup;
    private ctfMin = 0;
    private ctfMax = 1;
    private alphaScale: number;
    private readonly stepSize: number;
    private useGradient: number;
    private gradientType: number;
    private useSkip: number;
    private lassoDebug = 0;
    private scalpels: readonly ScalpelData[] = [];
    private scalpelDebug = 0;
    //Os lassos vigentes. Guardados como VIERAM (a lista do redux é imutável:
    //o reducer cria array novo a cada mudança), pra o rebuild dos recursos de
    //GPU ter de onde partir sem depender de quem chamou.
    private lassos: readonly LassoData[] = [];
    private readonly spacing: [number, number, number];
    private readonly numChunksX: number;
    private readonly numChunksY: number;
    private readonly numChunksZ: number;
    private readonly chunkSizeVoxels: number;

    /**
     * O material só AMOSTRA volumeTexture e gradientTexture; a posse (destroy) é
     * de quem as criou — o RaycastLassoWorld. O skip-map (occupiedBuffer) é do
     * material (ele o aloca e o destrói).
     */
    constructor(
        device: GPUDevice,
        volumeTexture: GPUTexture,
        gradientTexture: GPUTexture,
        /** mm por voxel [x,y,z] do exame (gradientParamsFromMetadata.spacing). */
        spacing: [number, number, number],
        /** Pontos de controle da CTF, ordenados por HU (ver ctf.ts). */
        ctfPoints: readonly CtfPoint[],
        /** Grade de chunks do exame (metadata) — dimensiona o skip-map + índice. */
        chunkGrid: ChunkGrid,
        alphaScale = 0.3,
        gradientShading = false,
        gradientType = 1,
        emptySpaceSkip = true,
        stepSize = DEFAULT_STEP_SIZE,
    ) {
        super();
        this.device = device;
        this.volumeTexture = volumeTexture;
        this.gradientTexture = gradientTexture;
        this.spacing = spacing;
        this.alphaScale = alphaScale;
        this.useGradient = gradientShading ? 1 : 0;
        this.gradientType = gradientType;
        this.useSkip = emptySpaceSkip ? 1 : 0;
        this.stepSize = stepSize;
        this.numChunksX = chunkGrid.numChunksX;
        this.numChunksY = chunkGrid.numChunksY;
        this.numChunksZ = chunkGrid.numChunksZ;
        this.chunkSizeVoxels = chunkGrid.chunkSize;

        this.paramsBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial params",
            //struct Params: spacing:vec3f e numChunks:vec3f alinham em 16, e os
            //dois f32 do bisturi fecham um quarto bloco → 80 bytes (20 floats)
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.preintTexture = device.createTexture({
            label: "VolumeRaycastLassoMaterial preintegration table",
            size: [PREINT_TABLE_SIZE, PREINT_TABLE_SIZE, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.occupiedBuffer = device.createBuffer({
            label: "VolumeRaycastLassoMaterial skip-map (occupied)",
            size: Math.max(chunkGrid.totalChunks, 1) * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        //default seguro: tudo ocupado (processa tudo) até o world/behaviour
        //mandarem o skip-map de verdade — assim nada é pulado por engano.
        //ANTES do setCtf: ele repassa a CTF pro passe de profundidade (o
        //critério de superfície depende dela), então o passe já tem que existir.
        this.depthPass = new ScalpelDepthPass(device);
        this.setSkipMap(new Uint32Array(chunkGrid.totalChunks).fill(1));
        this.setCtf(ctfPoints); //bakeia a tabela + a LUT do passe + os params

        //Sem lasso nem bisturi ainda, mas o layout exige os recursos: nascem
        //no tamanho mínimo (1 camada de 1×1) e o world/behaviour os trocam.
        this.createLassoResources([]);
        this.createScalpelResources([]);
        this.rebuildBindGroup();
    }

    /**
     * (Re)cria a textura de máscaras e o buffer de matrizes pra lista dada.
     * Uma camada por lasso; SEM lasso, uma camada de 1×1 zerada — o bind group
     * layout exige os dois recursos existindo, mesmo vazios, e alocar 512² pra
     * nada seria desperdício.
     */
    private createLassoResources(lassos: readonly LassoData[]): void {
        const layers = Math.max(lassos.length, 1);
        const size = lassos.length > 0 ? CONTOUR_MASK_SIZE : 1;
        this.lassoMaskTexture = this.device.createTexture({
            label: "VolumeRaycastLassoMaterial lasso masks",
            size: [size, size, layers],
            dimension: "2d",
            format: "r8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        //Rasterização na CPU, uma vez por lasso por edição — alguns ms, e só
        //quando a referência da lista troca (a behaviour é quem detecta).
        for (let i = 0; i < lassos.length; i++) {
            const mask = rasterizeContourMask(lassos[i].points, CONTOUR_MASK_SIZE);
            this.device.queue.writeTexture(
                { texture: this.lassoMaskTexture, origin: [0, 0, i] },
                mask,
                { bytesPerRow: CONTOUR_MASK_SIZE, rowsPerImage: CONTOUR_MASK_SIZE },
                [CONTOUR_MASK_SIZE, CONTOUR_MASK_SIZE, 1],
            );
        }
        //As matrizes na mesma ordem das camadas: o índice do laço do shader
        //serve pros dois.
        const matrices = new Float32Array(layers * 16);
        for (let i = 0; i < lassos.length; i++) {
            matrices.set(lassos[i].clipFromLocal, i * 16);
        }
        this.lassoClipBuffer = this.device.createBuffer({
            label: "VolumeRaycastLassoMaterial lasso matrices",
            size: matrices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.lassoClipBuffer, 0, matrices);
    }

    /**
     * (Re)cria os recursos do bisturi E captura os mapas de profundidade.
     *
     * A captura é o que diferencia isto do createLassoResources: além de
     * rasterizar o contorno na CPU, roda um render por bisturi (o
     * ScalpelDepthPass) pra descobrir onde está a superfície visível vista
     * daquela câmera. Tudo num encoder só, submetido na hora — não é trabalho
     * de frame, é trabalho de EDIÇÃO.
     *
     * Recria e recaptura TUDO a cada mudança, mesmo os bisturis que já tinham
     * mapa. Fica O(N) renders por edição, o que com um punhado de cortes é
     * imperceptível e mantém um caminho só — que é o mesmo usado quando a CTF
     * muda e todos os mapas ficam velhos de uma vez. Se um dia pesar, o
     * conserto é um array de capacidade fixa e recapturar só a camada nova.
     */
    private createScalpelResources(scalpels: readonly ScalpelData[]): void {
        const layers = Math.max(scalpels.length, 1);
        const size = scalpels.length > 0 ? CONTOUR_MASK_SIZE : 1;
        this.scalpelMaskTexture = this.device.createTexture({
            label: "VolumeRaycastLassoMaterial scalpel masks",
            size: [size, size, layers],
            dimension: "2d",
            format: "r8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.scalpelDepthTexture = this.device.createTexture({
            label: "VolumeRaycastLassoMaterial scalpel depths",
            size: [scalpels.length > 0 ? SCALPEL_DEPTH_SIZE : 1, scalpels.length > 0 ? SCALPEL_DEPTH_SIZE : 1, layers],
            dimension: "2d",
            //rg: entrada e saída da camada. Ver o ScalpelDepthPass.
            format: "rg32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        //struct Scalpel: mat4x4f (64B) + f32, com stride 80 pelo alinhamento
        //de 16 do mat4 — 20 floats por bisturi, margem no índice 16.
        const packed = new Float32Array(layers * 20);
        for (let i = 0; i < scalpels.length; i++) {
            packed.set(scalpels[i].clipFromLocal, i * 20);
            packed[i * 20 + 16] = scalpels[i].margin;
        }
        this.scalpelBuffer = this.device.createBuffer({
            label: "VolumeRaycastLassoMaterial scalpels",
            size: packed.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.scalpelBuffer, 0, packed);

        if (scalpels.length === 0) {
            return;
        }
        const encoder = this.device.createCommandEncoder({ label: "scalpel depth capture" });
        for (let i = 0; i < scalpels.length; i++) {
            const mask = rasterizeContourMask(scalpels[i].points, CONTOUR_MASK_SIZE);
            this.device.queue.writeTexture(
                { texture: this.scalpelMaskTexture, origin: [0, 0, i] },
                mask,
                { bytesPerRow: CONTOUR_MASK_SIZE, rowsPerImage: CONTOUR_MASK_SIZE },
                [CONTOUR_MASK_SIZE, CONTOUR_MASK_SIZE, 1],
            );
            //A inversa desprojeta o pixel de volta pro volume: é ela que dá o
            //raio daquela câmera congelada dentro do passe.
            const inverse = mat4.inverse(scalpels[i].clipFromLocal);
            this.depthPass.render(
                encoder,
                this.scalpelDepthTexture.createView({
                    dimension: "2d",
                    baseArrayLayer: i,
                    arrayLayerCount: 1,
                }),
                this.volumeTexture,
                this.gradientTexture,
                scalpels[i].clipFromLocal,
                inverse,
                this.ctfMin,
                this.ctfMax,
                DEFAULT_SURFACE_THRESHOLDS,
            );
        }
        this.device.queue.submit([encoder.finish()]);
    }

    private rebuildBindGroup(): void {
        this.bindGroup = this.device.createBindGroup({
            label: "VolumeRaycastLassoMaterial instance",
            layout: VolumeRaycastLassoMaterial.getMaterialBindGroupLayout(this.device),
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: VolumeRaycastLassoMaterial.getSampler(this.device) },
                { binding: 2, resource: this.volumeTexture.createView({ dimension: "3d" }) },
                { binding: 3, resource: this.preintTexture.createView() },
                { binding: 4, resource: this.gradientTexture.createView({ dimension: "3d" }) },
                { binding: 5, resource: { buffer: this.occupiedBuffer } },
                { binding: 6, resource: this.lassoMaskTexture.createView({ dimension: "2d-array" }) },
                { binding: 7, resource: { buffer: this.lassoClipBuffer } },
                { binding: 8, resource: this.scalpelMaskTexture.createView({ dimension: "2d-array" }) },
                { binding: 9, resource: { buffer: this.scalpelBuffer } },
                { binding: 10, resource: this.scalpelDepthTexture.createView({ dimension: "2d-array" }) },
            ],
        });
    }

    setCtf(points: readonly CtfPoint[]): void {
        //A CTF entra no critério de superfície do bisturi (alpha mínimo), então
        //os mapas de profundidade envelhecem junto com ela. Como o ScalpelData
        //guarda a matriz, dá pra recapturar todos — é exatamente por isso que a
        //matriz mora no dado e não só na GPU.
        this.depthPass.setCtf(points);
        const baked = bakePreIntegrationTable(points);
        this.ctfMin = baked.huMin;
        this.ctfMax = baked.huMax;
        this.device.queue.writeTexture(
            { texture: this.preintTexture },
            baked.data,
            { bytesPerRow: baked.size * 4, rowsPerImage: baked.size },
            [baked.size, baked.size, 1],
        );
        this.writeParams();
        //Depois do writeParams: a recaptura lê this.ctfMin/ctfMax novos.
        if (this.scalpels.length > 0) {
            this.setScalpels(this.scalpels);
        }
    }

    setAlphaScale(alphaScale: number): void {
        this.alphaScale = alphaScale;
        this.writeParams();
    }

    setGradientShading(enabled: boolean, onTheFly: boolean): void {
        this.useGradient = enabled ? 1 : 0;
        this.gradientType = onTheFly ? 1 : 0;
        this.writeParams();
    }

    /** Liga/desliga o empty-space skipping (pra A/B de velocidade). */
    setEmptySpaceSkip(enabled: boolean): void {
        this.useSkip = enabled ? 1 : 0;
        this.writeParams();
    }

    /**
     * Reescreve o skip-map inteiro (1 u32/chunk, 1=processa/0=pula). Chamado
     * pelo world na criação e pela behaviour toda vez que a CTF muda. O array
     * tem que ter totalChunks elementos, na ordem row-major (z,y,x).
     */
    setSkipMap(occupied: Uint32Array<ArrayBuffer>): void {
        this.device.queue.writeBuffer(this.occupiedBuffer, 0, occupied);
    }

    /**
     * Troca a lista de lassos vigente. Chamado pelo world na criação (a lista
     * sobrevive à troca de mundo, então um world novo pode já nascer com
     * lassos) e pela behaviour toda vez que a referência do array muda.
     *
     * Rasteriza as máscaras, refaz o array de matrizes e RECRIA o bind group
     * (as camadas do texture_2d_array são fixas na criação, então mudar de
     * quantidade é destruir e criar de novo — acontece uma vez por edição do
     * usuário, não por frame).
     *
     * Roda no update() da behaviour, nunca no meio de um frame: o main chama
     * update() antes de render(), então o bind group novo já vale no frame que
     * está sendo montado.
     */
    setLassos(lassos: readonly LassoData[]): void {
        this.lassos = lassos;
        this.lassoMaskTexture.destroy();
        this.lassoClipBuffer.destroy();
        this.createLassoResources(lassos);
        this.rebuildBindGroup();
        this.writeParams(); //lassoCount mudou
    }

    /** Debug view das máscaras: pinta a região dos lassos em vez de removê-la. */
    setLassoDebug(enabled: boolean): void {
        this.lassoDebug = enabled ? 1 : 0;
        this.writeParams();
    }

    /**
     * Troca a lista de bisturis: rasteriza os contornos, RECAPTURA os mapas de
     * profundidade e refaz o bind group. Bem mais caro que o setLassos (um
     * render por bisturi), e por isso só roda quando a lista muda de verdade —
     * a behaviour compara por referência.
     */
    setScalpels(scalpels: readonly ScalpelData[]): void {
        this.scalpels = scalpels;
        this.scalpelMaskTexture.destroy();
        this.scalpelDepthTexture.destroy();
        this.scalpelBuffer.destroy();
        this.createScalpelResources(scalpels);
        this.rebuildBindGroup();
        this.writeParams(); //scalpelCount mudou
    }

    /** Debug view do bisturi: pinta a casca (verde-piscina) em vez de removê-la. */
    setScalpelDebug(enabled: boolean): void {
        this.scalpelDebug = enabled ? 1 : 0;
        this.writeParams();
    }

    /** Quantos lassos estão vigentes (o shader vai precisar do mesmo número). */
    get lassoCount(): number {
        return this.lassos.length;
    }

    private writeParams(): void {
        //struct Params (uniform std140-ish): spacing:vec3f no byte 32 (índice 8),
        //numChunks:vec3f no byte 48 (índice 12). Os índices 11 e 15, que eram
        //padding dos vec3f, hoje carregam lassoCount e lassoDebug.
        this.device.queue.writeBuffer(
            this.paramsBuffer,
            0,
            new Float32Array([
                this.ctfMin, this.ctfMax, this.alphaScale, this.stepSize,
                this.useGradient, this.gradientType, this.useSkip, this.chunkSizeVoxels,
                this.spacing[0], this.spacing[1], this.spacing[2], this.lassos.length,
                this.numChunksX, this.numChunksY, this.numChunksZ, this.lassoDebug,
                this.scalpels.length, this.scalpelDebug, 0, 0,
            ]),
        );
    }

    override getPipeline(ctx: PipelineContext, meshType: MeshType): GPURenderPipeline {
        if (meshType !== MeshType.Static) {
            throw new Error(
                `VolumeRaycastLassoMaterial só desenha MeshType.Static (o proxy-cube), recebeu ${MeshType[meshType]}.`,
            );
        }
        if (!VolumeRaycastLassoMaterial.pipeline) {
            VolumeRaycastLassoMaterial.pipeline = VolumeRaycastLassoMaterial.createPipeline(ctx);
        }
        return VolumeRaycastLassoMaterial.pipeline;
    }

    override getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    /**
     * O buffer do skip-map (1 u32/chunk). O DebugChunksPass o lê pra saber
     * quais chunks desenhar — MESMA fonte de verdade, atualiza junto quando a
     * behaviour chama setSkipMap na mudança de CTF.
     */
    get skipMapBuffer(): GPUBuffer {
        return this.occupiedBuffer;
    }

    override destroy(): void {
        this.volumeTexture.destroy();
        this.preintTexture.destroy();
        this.paramsBuffer.destroy();
        this.occupiedBuffer.destroy();
        this.lassoMaskTexture.destroy();
        this.lassoClipBuffer.destroy();
        this.scalpelMaskTexture.destroy();
        this.scalpelDepthTexture.destroy();
        this.scalpelBuffer.destroy();
        this.depthPass.destroy();
    }
}
