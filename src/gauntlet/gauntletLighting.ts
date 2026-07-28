//GauntletLighting: dono do grupo 0 (frame + luzes), compartilhado entre
//GauntletMainRenderPass e GauntletSkinnedRenderPass. Só o Gauntlet usa isso
//— os outros mundos continuam com 1 luz hardcoded no shader deles.
//
//Responsabilidade: UMA travessia da árvore por frame que acha a câmera e
//agrupa todos os nós com `.light` por LightType, escreve o uniform de frame
//(view/proj/cameraPos/counts) e faz grow+upload dos 3 storage buffers. Os
//dois passes só leem `frameBindGroupLayout`/`frameBindGroup` — nenhum dos
//dois escreve mais em grupo 0 (antes cada um duplicava seu próprio Frame, e
//era por isso que "light0Pos" significava posição num pass e direção no
//outro — essa ambiguidade some com a unificação).
//
//Também é dona do FrustumCuller compartilhado: já anda a árvore e calcula
//view/proj pra achar a câmera, então extrair os planos daqui evita montar o
//mesmo frustum de novo em cada pass. Point/Spot lights fora dele (+ margem)
//não entram nos buffers — exceto as marcadas cullable=false (luzes globais
//tipo um "sol" direcional têm que iluminar a cena inteira mesmo fora do
//enquadramento). Directional não tem posição — nunca é testada.
//
//E, desde a rodada de shadow maps, é dona também dos 2 texture arrays de
//sombra (spot, directional — point ainda não tem, é a rodada seguinte) e das
//matrizes luz→clip usadas tanto pra escrever no grupo 0 (os materiais
//projetam o fragmento nelas) quanto pro GauntletShadowPass desenhar (ele lê
//`spotShadowViewProj`/`directionalShadowViewProj` e as views por-camada).
import { mat4, vec3, type Mat4, type Vec3 } from "wgpu-matrix";
import { Node } from "../node";
import { LightType, type PointLight, type SpotLight, type DirectionalLight } from "../Light";
import { FrustumCuller } from "../frustumCuller";

const FLOATS_PER_MAT4 = 16;
const FLOATS_PER_POINT = 8; // vec3 position + f32 intensity, vec3 color + f32 pad — 2×vec4
//vec3 position+intensity, vec3 direction+cosOuter, vec3 color+cosInner,
//mat4x4 shadowViewProj, f32 shadowIndex + vec3 pad — 8×vec4
const FLOATS_PER_SPOT = 32;
//vec3 direction+intensity, vec3 color+shadowIndex, mat4x4 shadowViewProj — 6×vec4
const FLOATS_PER_DIR = 24;
const FRAME_FLOATS = 2 * FLOATS_PER_MAT4 + 4 + 4; // view+proj+cameraPos+lightCounts, 160 bytes
//~2 tiles (tileWidth/Height=2, ver GauntletNetwork) de folga além do frustum
//exato, pra luz não sumir/aparecer de repente bem na borda da tela.
const LIGHT_CULL_MARGIN = 4;

//Shadow maps de spot/directional: depth-only, sampladas por comparação
//(sampler_comparison + textureSampleCompare no fragment shader — é isso que
//dá o soft shadow via PCF, ver os materiais). Mesmo formato de depth já usado
//nos passes de mesh (depth24plus) — já provado neste engine como sampleável
//(o depth do main pass já é lido pelo SmokeVolumePass do gameVolume).
export const SHADOW_DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
export const DEFAULT_SHADOW_MAP_SIZE = 4096;
export const SHADOW_MAP_MIN_SIZE = 64;
export const SHADOW_MAP_MAX_SIZE = 8192;
//Perspective da sombra do spot: fovY = 2×outerConeAngle (cobre o cone
//inteiro), near/far fixos — a escala da dungeon é conhecida (~64×64).
const SPOT_SHADOW_NEAR = 0.5;
const SPOT_SHADOW_FAR = 60;

/**
 * Meia-largura, em unidades de mundo, da caixa ortho do shadow map do
 * directional, centrada no que a câmera está olhando (ver
 * computeDirectionalShadowViewProj). 24 = caixa de 48×48.
 *
 * O ortho ANTES cobria a dungeon inteira (64×64), o que gastava a resolução do
 * mapa quase toda em canto de mapa que ninguém está vendo. Como a luz é
 * PARALELA, encolher e transladar a caixa não muda a direção de raio nenhum:
 * muda só onde existe dado de sombra e com que densidade. O texel cai de
 * 64/size pra 48/size — e o shadow pass, que já culla contra o frustum da luz,
 * passa a coletar e ordenar muito menos item por frame.
 *
 * O tamanho é FIXO de propósito, nunca refitado por frame: caixa que muda de
 * tamanho faz a sombra inteira pulsar. Com a câmera do Gauntlet (offset fixo,
 * sem giro), a região visível é uma forma constante e só a translação muda,
 * então um raio fixo cobre bem. Aumente se a câmera afastar; sombra sumindo na
 * borda da tela é o sintoma de estar curto demais.
 */
const DIRECTIONAL_SHADOW_RADIUS = 24;
//Até onde procurar o chão na frente da câmera, quando ela é rasa demais pra
//cruzar y=0 num ponto útil (ver cameraGroundFocus).
const CAMERA_FOCUS_MAX_DISTANCE = 60;

export class GauntletLighting {
    readonly frameBindGroupLayout: GPUBindGroupLayout;
    /**
     * Frustum da câmera deste frame — atualizado dentro de updateFrame(),
     * ANTES de qualquer pass.render()/renderOnto() rodar. Os passes usam
     * isto pra cullar seus próprios renderables (cada um com sua margem);
     * aqui dentro é usado pra cullar as luzes point/spot.
     */
    readonly frustum = new FrustumCuller();

    /**
     * Matriz luz→clip (proj*view) de cada spot/directional VISÍVEL deste
     * frame, na MESMA ordem/tamanho gravado em `lightCounts` — o
     * GauntletShadowPass usa isto pra desenhar o depth de cada luz, e o
     * valor gravado no storage buffer (shadowViewProj) é o mesmo, pro
     * fragment shader projetar o fragmento no shadow map.
     */
    spotShadowViewProj: Mat4[] = [];
    directionalShadowViewProj: Mat4[] = [];

    private readonly device: GPUDevice;
    private readonly frameBuffer: GPUBuffer;
    private readonly frameFloats = new Float32Array(FRAME_FLOATS);
    //Mesmo ArrayBuffer visto como u32 — os counts precisam do bit pattern
    //inteiro (escrever floatArray[i]=3 grava o FLOAT 3.0, não o u32 3).
    private readonly frameU32 = new Uint32Array(this.frameFloats.buffer);

    private pointCapacity = 0;
    private pointBuffer!: GPUBuffer;
    private pointData!: Float32Array<ArrayBuffer>;
    private spotCapacity = 0;
    private spotBuffer!: GPUBuffer;
    private spotData!: Float32Array<ArrayBuffer>;
    private dirCapacity = 0;
    private dirBuffer!: GPUBuffer;
    private dirData!: Float32Array<ArrayBuffer>;

    //Resolução ATUAL dos 2 arrays de shadow map — controlável em tempo real
    //(ver setShadowMapSize, chamado pelo GauntletWorld a cada update() lendo
    //o redux). AABB da dungeon pra fitar o ortho do directional (ver
    //setShadowSceneBounds) — default inofensivo até o GauntletWorld chamar.
    private shadowMapSize = DEFAULT_SHADOW_MAP_SIZE;
    private readonly sceneBoundsMin: Vec3 = vec3.create(-1, -1, -1);
    private readonly sceneBoundsMax: Vec3 = vec3.create(1, 1, 1);
    private shadowSampler!: GPUSampler;

    private spotShadowCapacity = 0;
    private spotShadowTexture!: GPUTexture;
    private spotShadowArrayView!: GPUTextureView;
    private spotShadowLayerViews: GPUTextureView[] = [];
    private dirShadowCapacity = 0;
    private dirShadowTexture!: GPUTexture;
    private dirShadowArrayView!: GPUTextureView;
    private dirShadowLayerViews: GPUTextureView[] = [];

    private _frameBindGroup!: GPUBindGroup;
    private _hasCamera = false;

    constructor(device: GPUDevice) {
        this.device = device;
        this.frameBindGroupLayout = device.createBindGroupLayout({
            label: "gauntlet lighting frame (grupo 0)",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
            ],
        });
        this.frameBuffer = device.createBuffer({
            label: "gauntlet lighting frame (view+proj+cameraPos+lightCounts)",
            size: this.frameFloats.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.shadowSampler = device.createSampler({
            label: "gauntlet shadow sampler",
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
        });
        this.growPointBuffer(8);
        this.growSpotBuffer(8);
        this.growDirectionalBuffer(8);
        this.growSpotShadowArray(4);
        this.growDirectionalShadowArray(2);
        this.rebuildFrameBindGroup();
    }

    get frameBindGroup(): GPUBindGroup {
        return this._frameBindGroup;
    }

    /** false quando não há nó de câmera na árvore — os passes devem pular o draw. */
    get hasCamera(): boolean {
        return this._hasCamera;
    }

    /** View 2D (1 camada) do shadow map do spot visível de índice `i` — pro GauntletShadowPass desenhar nela. */
    getSpotShadowLayerView(i: number): GPUTextureView {
        return this.spotShadowLayerViews[i];
    }

    /** Idem, pro directional visível de índice `i`. */
    getDirectionalShadowLayerView(i: number): GPUTextureView {
        return this.dirShadowLayerViews[i];
    }

    /**
     * AABB de mundo usado pra fitar o ortho do shadow map dos directionals
     * (não há "posição" de luz direcional — a caixa vem da CENA, não da
     * luz). Chamar 1x depois de carregar a geometria estática (dungeon);
     * antes disso vale o default (caixa unitária na origem), inofensivo
     * porque nada real é desenhado até o 1º createWorld terminar.
     */
    setShadowSceneBounds(min: Vec3, max: Vec3): void {
        vec3.copy(min, this.sceneBoundsMin);
        vec3.copy(max, this.sceneBoundsMax);
    }

    /**
     * Resolução (largura=altura) dos 2 arrays de shadow map. Chamado pelo
     * GauntletWorld a cada update(), lendo o redux (padrão lastSeen) — é
     * a exceção combinada ao padrão UI→behaviour: aqui é o WORLD que lê.
     * Clampa defensivamente (a UI já clampa, mas o redux pode ser editado
     * direto pelo devtools).
     */
    setShadowMapSize(size: number): void {
        const clamped = Math.max(SHADOW_MAP_MIN_SIZE, Math.min(SHADOW_MAP_MAX_SIZE, Math.floor(size)));
        if (clamped === this.shadowMapSize) {
            return;
        }
        this.shadowMapSize = clamped;
        this.recreateSpotShadowTexture(this.spotShadowCapacity);
        this.recreateDirectionalShadowTexture(this.dirShadowCapacity);
        this.rebuildFrameBindGroup();
    }

    /** Chamar UMA vez por frame, antes de qualquer pass.render()/renderOnto(). */
    updateFrame(root: Node, width: number, height: number): void {
        let cameraNode: Node | null = null;
        const points: Node[] = [];
        const spots: Node[] = [];
        const directionals: Node[] = [];

        //Só lê o cache de worldMatrix, que o World.update deste frame já
        //preencheu (o main chama update antes do render) — aqui não se
        //calcula matriz nenhuma.
        const collect = (node: Node) => {
            if (node.camera && !cameraNode) {
                cameraNode = node; //primeira câmera achada é A câmera
            }
            if (node.light) {
                switch (node.light.type) {
                    case LightType.Point: points.push(node); break;
                    case LightType.Spot: spots.push(node); break;
                    case LightType.Directional: directionals.push(node); break;
                }
            }
            for (const child of node.children) {
                collect(child);
            }
        };
        collect(root);

        this._hasCamera = cameraNode !== null;
        //Sem câmera não há frustum válido pra testar — nesse caso (raro,
        //degenerado) nenhuma luz é cullada; os passes já limpam os items
        //deles quando hasCamera é false, então não há nada real desenhando.
        let visiblePoints = points;
        let visibleSpots = spots;
        if (cameraNode) {
            const cam = cameraNode as Node;
            cam.camera!.aspect = width / height; //segue o canvas automaticamente
            const view = mat4.invert(cam.worldMatrix); //invert não muta a fonte
            const proj = cam.camera!.getProjectionMatrix();
            this.frameFloats.set(view, 0);
            this.frameFloats.set(proj, FLOATS_PER_MAT4);
            //posição de MUNDO da câmera — cam.position é LOCAL. Bug que
            //existia no MainRenderPass/SkinnedRenderPass originais (só não
            //aparecia porque a câmera sempre foi filha direta do root).
            const base = 2 * FLOATS_PER_MAT4;
            this.frameFloats[base + 0] = cam.worldMatrix[12];
            this.frameFloats[base + 1] = cam.worldMatrix[13];
            this.frameFloats[base + 2] = cam.worldMatrix[14];
            this.frameFloats[base + 3] = 1;

            //Mesma ordem do shader (frame.proj * frame.view * worldPos): o
            //frustum tem que ser extraído da matriz combinada proj*view.
            this.frustum.update(mat4.multiply(proj, view));
            visiblePoints = points.filter(
                (n) => !n.light!.cullable || this.frustum.containsPoint(worldPosition(n), LIGHT_CULL_MARGIN),
            );
            visibleSpots = spots.filter(
                (n) => !n.light!.cullable || this.frustum.containsPoint(worldPosition(n), LIGHT_CULL_MARGIN),
            );
        }
        const countsBase = 2 * FLOATS_PER_MAT4 + 4;
        this.frameU32[countsBase + 0] = visiblePoints.length;
        this.frameU32[countsBase + 1] = visibleSpots.length;
        this.frameU32[countsBase + 2] = directionals.length;
        this.frameU32[countsBase + 3] = 0;
        this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameFloats);

        //Matrizes luz→clip de sombra: calculadas ANTES de gravar os storage
        //buffers (writeSpot/writeDirectional gravam a matriz no lugar).
        this.spotShadowViewProj = visibleSpots.map((n) => this.computeSpotShadowViewProj(n));
        //A caixa do directional segue a câmera. Sem câmera (caso degenerado)
        //cai no comportamento antigo, cena inteira — melhor sombra grosseira
        //que sombra nenhuma.
        const shadowFocus = cameraNode ? cameraGroundFocus(cameraNode) : null;
        this.directionalShadowViewProj = directionals.map((n) => this.computeDirectionalShadowViewProj(n, shadowFocus));

        let bindGroupDirty = false;
        if (visiblePoints.length > this.pointCapacity) { this.growPointBuffer(visiblePoints.length); bindGroupDirty = true; }
        if (visibleSpots.length > this.spotCapacity) { this.growSpotBuffer(visibleSpots.length); bindGroupDirty = true; }
        if (directionals.length > this.dirCapacity) { this.growDirectionalBuffer(directionals.length); bindGroupDirty = true; }
        if (visibleSpots.length > this.spotShadowCapacity) { this.growSpotShadowArray(visibleSpots.length); bindGroupDirty = true; }
        if (directionals.length > this.dirShadowCapacity) { this.growDirectionalShadowArray(directionals.length); bindGroupDirty = true; }
        if (bindGroupDirty) this.rebuildFrameBindGroup();

        visiblePoints.forEach((node, i) => this.writePoint(node, i));
        visibleSpots.forEach((node, i) => this.writeSpot(node, i));
        directionals.forEach((node, i) => this.writeDirectional(node, i));

        if (visiblePoints.length) this.device.queue.writeBuffer(this.pointBuffer, 0, this.pointData, 0, visiblePoints.length * FLOATS_PER_POINT);
        if (visibleSpots.length) this.device.queue.writeBuffer(this.spotBuffer, 0, this.spotData, 0, visibleSpots.length * FLOATS_PER_SPOT);
        if (directionals.length) this.device.queue.writeBuffer(this.dirBuffer, 0, this.dirData, 0, directionals.length * FLOATS_PER_DIR);
    }

    //Câmera de sombra do spot: olha na direção do nó (mesma convenção -Z de
    //Camera/Node.lookAt), FOV = o cone inteiro, near/far fixos (escala da
    //dungeon é conhecida). cameraAim+invert é o mesmo idioma de Node.lookAt,
    //só que sem precisar de um Node (matriz crua).
    private computeSpotShadowViewProj(node: Node): Mat4 {
        const light = node.light as SpotLight;
        const pos = worldPosition(node);
        const dir = forward(node.worldMatrix);
        const target = vec3.create(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]);
        const view = mat4.invert(mat4.cameraAim(pos, target, safeUp(dir)));
        const proj = mat4.perspective(2 * light.outerConeAngle, 1, SPOT_SHADOW_NEAR, SPOT_SHADOW_FAR);
        return mat4.multiply(proj, view);
    }

    /**
     * Câmera de sombra do directional: não tem posição própria (fonte
     * infinitamente distante), então a "câmera" é sintética — colocada atrás do
     * CENTRO DA CENA, na direção oposta à da luz, longe o bastante pra nunca
     * ficar DENTRO da caixa.
     *
     * O eye é ancorado na cena, e NÃO na câmera do player, de propósito: assim a
     * matriz de view é a mesma todo frame, e as coordenadas de um ponto de mundo
     * no espaço da luz não mudam quando o player anda. É isso que faz o snap de
     * texel lá embaixo funcionar — snap contra um referencial móvel não
     * estabiliza nada.
     *
     * Os eixos da caixa saem de duas fontes diferentes, e a assimetria é o
     * ponto:
     *  - X e Y (perpendiculares à luz): APERTADOS em volta do que a câmera está
     *    olhando, porque é só ali que a sombra vai ser vista. É a economia toda.
     *  - Z (ao longo da luz): a CENA INTEIRA. Se apertasse aqui também, sumiria
     *    o caster que está entre o sol e a área visível — a parede fora de
     *    quadro que projeta sombra pra dentro dele. Esticar em profundidade não
     *    custa texel nenhum, só range de depth.
     *
     * `focus` null = sem câmera: cai no comportamento antigo (cena inteira).
     */
    private computeDirectionalShadowViewProj(node: Node, focus: Vec3 | null): Mat4 {
        const dir = forward(node.worldMatrix);
        const min = this.sceneBoundsMin;
        const max = this.sceneBoundsMax;
        const center = vec3.create((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
        const eye = vec3.create(
            center[0] - dir[0] * radius * 2,
            center[1] - dir[1] * radius * 2,
            center[2] - dir[2] * radius * 2,
        );
        const view = mat4.invert(mat4.cameraAim(eye, center, safeUp(dir)));

        //Os 8 cantos do AABB da cena no espaço da luz (mesma técnica de
        //Renderable.worldAABB, só que mundo→luz em vez de local→mundo).
        let sceneMinX = Infinity, sceneMinY = Infinity, minZ = Infinity;
        let sceneMaxX = -Infinity, sceneMaxY = -Infinity, maxZ = -Infinity;
        for (let c = 0; c < 8; c++) {
            const x = (c & 1) ? max[0] : min[0];
            const y = (c & 2) ? max[1] : min[1];
            const z = (c & 4) ? max[2] : min[2];
            const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
            const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
            const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
            if (vx < sceneMinX) sceneMinX = vx; if (vy < sceneMinY) sceneMinY = vy; if (vz < minZ) minZ = vz;
            if (vx > sceneMaxX) sceneMaxX = vx; if (vy > sceneMaxY) sceneMaxY = vy; if (vz > maxZ) maxZ = vz;
        }

        let minX = sceneMinX, maxX = sceneMaxX, minY = sceneMinY, maxY = sceneMaxY;
        if (focus) {
            //Foco no espaço da luz. Só X e Y interessam: Z já veio da cena.
            const fx = view[0] * focus[0] + view[4] * focus[1] + view[8] * focus[2] + view[12];
            const fy = view[1] * focus[0] + view[5] * focus[1] + view[9] * focus[2] + view[13];
            //SNAP a múltiplos de texel. Sem isto, o deslocamento sub-texel da
            //caixa faz os texels do mapa deslizarem sobre a geometria parada e
            //as bordas de sombra FERVEM a cada frame — e o defeito piora quanto
            //melhor a resolução, porque o texel fica menor. Arredondar o centro
            //pro grid faz a caixa andar de texel em texel: o conteúdo do mapa
            //translada em bloco, sem reamostrar.
            const texel = (2 * DIRECTIONAL_SHADOW_RADIUS) / this.shadowMapSize;
            const snappedX = Math.round(fx / texel) * texel;
            const snappedY = Math.round(fy / texel) * texel;
            //A caixa NÃO é clampada ao AABB da cena, mesmo perto da borda do
            //mapa. Clampar mudaria a EXTENSÃO de frame pra frame, e aí o texel
            //real deixaria de bater com o grid usado no snap acima — o
            //shimmering voltaria justamente na borda. E não economizaria nada:
            //texel sobre o vazio não rasteriza coisa nenhuma. Extensão
            //constante é o que faz o snap valer.
            minX = snappedX - DIRECTIONAL_SHADOW_RADIUS;
            maxX = snappedX + DIRECTIONAL_SHADOW_RADIUS;
            minY = snappedY - DIRECTIONAL_SHADOW_RADIUS;
            maxY = snappedY + DIRECTIONAL_SHADOW_RADIUS;
        }
        //view-space -Z é "na frente" (convenção do engine inteiro): maxZ
        //(menos negativo) é o corner mais PERTO da câmera sintética, minZ o
        //mais LONGE — near/far do ortho são as distâncias positivas.
        const near = Math.max(0.05, -maxZ);
        const far = -minZ;
        const proj = mat4.ortho(minX, maxX, minY, maxY, near, far);
        return mat4.multiply(proj, view);
    }

    private writePoint(node: Node, i: number): void {
        const light = node.light as PointLight; //seguro: node veio do bucket LightType.Point
        const base = i * FLOATS_PER_POINT;
        this.pointData.set(worldPosition(node), base);
        this.pointData[base + 3] = light.intensity;
        this.pointData.set(light.color, base + 4);
        this.pointData[base + 7] = 0; //reservado (vira shadowIndex no round 2 do point light)
    }

    private writeSpot(node: Node, i: number): void {
        const light = node.light as SpotLight;
        const base = i * FLOATS_PER_SPOT;
        this.spotData.set(worldPosition(node), base);
        this.spotData[base + 3] = light.intensity;
        const [fx, fy, fz] = forward(node.worldMatrix);
        this.spotData[base + 4] = fx;
        this.spotData[base + 5] = fy;
        this.spotData[base + 6] = fz;
        this.spotData[base + 7] = Math.cos(light.outerConeAngle);
        this.spotData.set(light.color, base + 8);
        this.spotData[base + 11] = Math.cos(light.innerConeAngle);
        this.spotData.set(this.spotShadowViewProj[i], base + 12); //mat4x4, offsets 12..27
        this.spotData[base + 28] = i; //shadowIndex: a própria posição no array visível deste frame
        this.spotData[base + 29] = 0;
        this.spotData[base + 30] = 0;
        this.spotData[base + 31] = 0;
    }

    private writeDirectional(node: Node, i: number): void {
        const light = node.light as DirectionalLight;
        const base = i * FLOATS_PER_DIR;
        const [fx, fy, fz] = forward(node.worldMatrix);
        this.dirData[base + 0] = fx;
        this.dirData[base + 1] = fy;
        this.dirData[base + 2] = fz;
        this.dirData[base + 3] = light.intensity;
        this.dirData.set(light.color, base + 4);
        this.dirData[base + 7] = i; //shadowIndex
        this.dirData.set(this.directionalShadowViewProj[i], base + 8); //mat4x4, offsets 8..23
    }

    private growPointBuffer(minCount: number): void {
        let capacity = Math.max(this.pointCapacity, 8);
        while (capacity < minCount) capacity *= 2;
        this.pointBuffer?.destroy();
        this.pointCapacity = capacity;
        this.pointData = new Float32Array(capacity * FLOATS_PER_POINT);
        this.pointBuffer = this.device.createBuffer({
            label: "gauntlet lighting point lights",
            size: capacity * FLOATS_PER_POINT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private growSpotBuffer(minCount: number): void {
        let capacity = Math.max(this.spotCapacity, 8);
        while (capacity < minCount) capacity *= 2;
        this.spotBuffer?.destroy();
        this.spotCapacity = capacity;
        this.spotData = new Float32Array(capacity * FLOATS_PER_SPOT);
        this.spotBuffer = this.device.createBuffer({
            label: "gauntlet lighting spot lights",
            size: capacity * FLOATS_PER_SPOT * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private growDirectionalBuffer(minCount: number): void {
        let capacity = Math.max(this.dirCapacity, 8);
        while (capacity < minCount) capacity *= 2;
        this.dirBuffer?.destroy();
        this.dirCapacity = capacity;
        this.dirData = new Float32Array(capacity * FLOATS_PER_DIR);
        this.dirBuffer = this.device.createBuffer({
            label: "gauntlet lighting directional lights",
            size: capacity * FLOATS_PER_DIR * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private growSpotShadowArray(minCount: number): void {
        let capacity = Math.max(this.spotShadowCapacity, 4);
        while (capacity < minCount) capacity *= 2;
        this.recreateSpotShadowTexture(capacity);
    }

    private growDirectionalShadowArray(minCount: number): void {
        let capacity = Math.max(this.dirShadowCapacity, 2);
        while (capacity < minCount) capacity *= 2;
        this.recreateDirectionalShadowTexture(capacity);
    }

    //Recria a textura INTEIRA (array + views) na resolução ATUAL
    //(this.shadowMapSize) com a capacidade dada — usada tanto quando o Nº de
    //luzes cresce (capacidade nova, mesma resolução) quanto quando a
    //resolução muda via setShadowMapSize (mesma capacidade, textura nova).
    private recreateSpotShadowTexture(capacity: number): void {
        this.spotShadowTexture?.destroy();
        this.spotShadowCapacity = capacity;
        this.spotShadowTexture = this.device.createTexture({
            label: "gauntlet spot shadow maps",
            size: [this.shadowMapSize, this.shadowMapSize, capacity],
            format: SHADOW_DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.spotShadowArrayView = this.spotShadowTexture.createView({
            label: "gauntlet spot shadow maps (array)",
            dimension: "2d-array",
        });
        this.spotShadowLayerViews = [];
        for (let i = 0; i < capacity; i++) {
            this.spotShadowLayerViews.push(this.spotShadowTexture.createView({
                label: `gauntlet spot shadow map layer ${i}`,
                dimension: "2d",
                baseArrayLayer: i,
                arrayLayerCount: 1,
            }));
        }
    }

    private recreateDirectionalShadowTexture(capacity: number): void {
        this.dirShadowTexture?.destroy();
        this.dirShadowCapacity = capacity;
        this.dirShadowTexture = this.device.createTexture({
            label: "gauntlet directional shadow maps",
            size: [this.shadowMapSize, this.shadowMapSize, capacity],
            format: SHADOW_DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.dirShadowArrayView = this.dirShadowTexture.createView({
            label: "gauntlet directional shadow maps (array)",
            dimension: "2d-array",
        });
        this.dirShadowLayerViews = [];
        for (let i = 0; i < capacity; i++) {
            this.dirShadowLayerViews.push(this.dirShadowTexture.createView({
                label: `gauntlet directional shadow map layer ${i}`,
                dimension: "2d",
                baseArrayLayer: i,
                arrayLayerCount: 1,
            }));
        }
    }

    private rebuildFrameBindGroup(): void {
        this._frameBindGroup = this.device.createBindGroup({
            label: "gauntlet lighting frame",
            layout: this.frameBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.frameBuffer } },
                { binding: 1, resource: { buffer: this.pointBuffer } },
                { binding: 2, resource: { buffer: this.spotBuffer } },
                { binding: 3, resource: { buffer: this.dirBuffer } },
                { binding: 4, resource: this.spotShadowArrayView },
                { binding: 5, resource: this.dirShadowArrayView },
                { binding: 6, resource: this.shadowSampler },
            ],
        });
    }

    destroy(): void {
        this.frameBuffer.destroy();
        this.pointBuffer.destroy();
        this.spotBuffer.destroy();
        this.dirBuffer.destroy();
        this.spotShadowTexture.destroy();
        this.dirShadowTexture.destroy();
    }
}

//forward = -Z da worldMatrix em coords de mundo (column-major: colunas 0-2
//são os eixos X/Y/Z locais). Mesma convenção do Camera (ver camera.ts).
function forward(m: Mat4): [number, number, number] {
    let fx = -m[8], fy = -m[9], fz = -m[10];
    const len = Math.hypot(fx, fy, fz) || 1;
    return [fx / len, fy / len, fz / len];
}

//Posição de MUNDO do nó (translação da worldMatrix, índices 12-14) — usada
//tanto pro teste de frustum quanto pro valor gravado no buffer da GPU.
function worldPosition(node: Node): Vec3 {
    const w = node.worldMatrix;
    return vec3.create(w[12], w[13], w[14]);
}

/**
 * Ponto do CHÃO (y=0, onde mora o piso da dungeon) pra onde a câmera olha — o
 * centro da caixa de sombra do directional.
 *
 * É o chão, e não a posição da câmera, porque é no chão que a sombra é vista:
 * centrar na câmera gastaria metade da caixa no ar acima do mapa. Câmera rasa
 * demais pra cruzar y=0 (ou olhando pra cima) não tem interseção útil, e aí um
 * ponto à frente a uma distância fixa é o melhor palpite disponível.
 */
function cameraGroundFocus(cam: Node): Vec3 {
    const m = cam.worldMatrix;
    const dir = forward(m); //-Z, a convenção de câmera do engine
    const eyeY = m[13];
    //dir[1] < 0 = olhando pra baixo; o limiar evita divisão por ~0 na horizontal
    const t = dir[1] < -1e-3 ? -eyeY / dir[1] : CAMERA_FOCUS_MAX_DISTANCE;
    const d = Math.min(Math.max(t, 0), CAMERA_FOCUS_MAX_DISTANCE);
    return vec3.create(m[12] + dir[0] * d, m[13] + dir[1] * d, m[14] + dir[2] * d);
}

//Up seguro pra cameraAim: se a direção já está quase paralela a (0,1,0), usar
//(0,1,0) como up degenera a base (mesmo cuidado do spot do player em
//GauntletNetwork.ts).
function safeUp(dir: readonly [number, number, number]): Vec3 {
    return Math.abs(dir[1]) > 0.99 ? vec3.create(0, 0, 1) : vec3.create(0, 1, 0);
}
