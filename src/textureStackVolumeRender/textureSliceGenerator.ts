//Behaviour que gera as fatias view-aligned do VR clássico. Pendura num nó
//"pilha"; a caixa do volume é [-0.5, 0.5]³ no espaço LOCAL desse nó (uvw =
//pos + 0.5 — ver sliceMesh.ts).
//
//No primeiro update cria sliceCount nós filhos, um por fatia, cada um com
//uma SliceMesh e o material recebido (passMask = TransparentSlices). Daí
//em diante, sempre que a câmera ou o nó-pilha se movem, recalcula os
//polígonos de interseção dos planos (perpendiculares ao forward da câmera)
//com a caixa e reescreve os vértices de cada mesh.
//
//ORDEM SEM REORDENAÇÃO: o TransparentSlicesRenderPass desenha na ordem da
//árvore, e a ordem dos filhos aqui é FIXA — quem muda é o CONTEÚDO: o
//filho i sempre recebe o i-ésimo plano contando DE TRÁS (mais longe da
//câmera primeiro). Back-to-front por construção, sem mutar children — que
//aliás seria mutação durante a travessia do World.update.
//
//Criar os filhos dentro do update é seguro pelo contrato da travessia: as
//behaviours de um nó rodam ANTES de descer pros filhos, então os nós
//criados aqui são visitados (e ganham worldMatrix) neste mesmo frame.
//
//NÃO está no registry de behaviours: precisa de argumentos (device,
//material) — anexa à mão no createWorld, como a HelloReactBehaviour.
//
//O mundo deve chamar generator.destroy() no destroy() dele: as SliceMesh
//são criadas aqui e o mundo não as conhece.
import { Behaviour } from "../behaviour";
import { Node } from "../node";
import { Renderable, RenderPassBit } from "../renderable";
import type { Material } from "../material";
import { SliceMesh } from "./sliceMesh";

//os 8 cantos da caixa unitária [-0.5, 0.5]³, e as 12 arestas como pares
//de índices nos cantos
const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
];
const EDGES: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [2, 3], [4, 5], [6, 7], //arestas ao longo de X
    [0, 2], [1, 3], [4, 6], [5, 7], //ao longo de Y
    [0, 4], [1, 5], [2, 6], [3, 7], //ao longo de Z
];

export class TextureSliceGenerator extends Behaviour {
    private readonly device: GPUDevice;
    private readonly material: Material;
    private sliceCount: number;

    private meshes: SliceMesh[] = [];
    //os nós-fatia criados por createSliceNodes — guardados pra poder
    //derrubá-los num setSliceCount
    private sliceNodes: Node[] = [];
    private created = false;
    private cameraNode: Node | null = null;
    private warnedNoCamera = false;

    //snapshot das matrizes da última geração — se nada mudou, não regera
    private readonly lastCamera = new Float32Array(16);
    private readonly lastStack = new Float32Array(16);
    private hasSnapshot = false;

    //scratch de um vértice-buffer de fatia, reusado (writeBuffer copia)
    private readonly scratch = new Float32Array(SliceMesh.VERTS * SliceMesh.FLOATS_PER_VERTEX);

    constructor(device: GPUDevice, material: Material, sliceCount = 128) {
        super();
        this.device = device;
        this.material = material;
        this.sliceCount = sliceCount;
    }

    update(_deltaTime: number): void {
        if (!this.created) {
            this.createSliceNodes();
            this.created = true;
        }
        const camera = this.findCamera();
        if (!camera) {
            if (!this.warnedNoCamera) {
                console.warn("TextureSliceGenerator: nenhum nó com camera na árvore — fatias não geradas.");
                this.warnedNoCamera = true;
            }
            return;
        }
        //As worldMatrix lidas aqui são as fechadas na última travessia que
        //passou por elas — pode haver 1 frame de atraso se a câmera vier
        //depois deste nó na árvore. Irrelevante na prática (a geometria
        //converge no frame seguinte).
        if (this.hasSnapshot && !this.viewChanged(camera)) {
            return;
        }
        this.regenerate(camera);
        this.lastCamera.set(camera.worldMatrix);
        this.lastStack.set(this.node.worldMatrix);
        this.hasSnapshot = true;
    }

    /** Libera as meshes das fatias — o mundo chama isto no destroy() dele. */
    destroy(): void {
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.sliceNodes = [];
    }

    /**
     * Troca a quantidade de fatias EM VIVO: derruba os nós-fatia atuais e
     * recria com a contagem nova, regenerando os vértices JÁ — sem esperar
     * o próximo update, senão haveria um frame com o volume sumido (e num
     * arrasto de slider contínuo, sumido o arrasto inteiro).
     *
     * Seguro chamar de outra behaviour do MESMO nó (é o caso de uso): as
     * behaviours de um nó rodam antes da travessia descer pros filhos,
     * então mexer nos filhos aqui é o mesmo contrato do createSliceNodes
     * — os nós novos são visitados neste mesmo frame.
     */
    setSliceCount(count: number): void {
        if (count === this.sliceCount) {
            return;
        }
        this.sliceCount = count;
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        for (const sliceNode of this.sliceNodes) {
            this.node.removeChild(sliceNode);
        }
        this.sliceNodes = [];
        this.createSliceNodes();
        this.created = true; //o update não deve criar de novo
        const camera = this.findCamera();
        if (camera) {
            //mesma leitura de worldMatrix do caminho normal do update
            //(pode ter 1 frame de atraso; converge no seguinte)
            this.regenerate(camera);
            this.lastCamera.set(camera.worldMatrix);
            this.lastStack.set(this.node.worldMatrix);
            this.hasSnapshot = true;
        } else {
            this.hasSnapshot = false; //update regenera quando houver câmera
        }
    }

    private createSliceNodes(): void {
        for (let i = 0; i < this.sliceCount; i++) {
            const name = `slice_${String(i).padStart(3, "0")}`;
            const mesh = new SliceMesh(this.device, name);
            this.meshes.push(mesh);

            const sliceNode = new Node();
            sliceNode.name = name;
            //transform local identidade: os vértices já estão no espaço
            //local do nó-pilha, então worldMatrix da fatia == a da pilha
            sliceNode.renderable = new Renderable(mesh);
            sliceNode.renderable.material = this.material;
            sliceNode.renderable.passMask = RenderPassBit.TransparentSlices;
            this.node.addChild(sliceNode);
            this.sliceNodes.push(sliceNode);
        }
    }

    private findCamera(): Node | null {
        if (this.cameraNode) {
            return this.cameraNode; //behaviour morre com o mundo, cache não vira dangling
        }
        let root: Node = this.node;
        while (root.parent) {
            root = root.parent;
        }
        const visit = (node: Node): Node | null => {
            if (node.camera) return node;
            for (const child of node.children) {
                const found = visit(child);
                if (found) return found;
            }
            return null;
        };
        this.cameraNode = visit(root);
        return this.cameraNode;
    }

    private viewChanged(camera: Node): boolean {
        const cm = camera.worldMatrix;
        const sm = this.node.worldMatrix;
        for (let i = 0; i < 16; i++) {
            if (cm[i] !== this.lastCamera[i] || sm[i] !== this.lastStack[i]) {
                return true;
            }
        }
        return false;
    }

    private regenerate(camera: Node): void {
        //forward da câmera em mundo = -Z da worldMatrix dela (column-major:
        //coluna 2 = eixo Z local em coords de mundo)
        const cm = camera.worldMatrix;
        let fx = -cm[8], fy = -cm[9], fz = -cm[10];
        const flen = Math.hypot(fx, fy, fz);
        fx /= flen; fy /= flen; fz /= flen;

        //Normal dos planos no espaço LOCAL do nó-pilha. Plano em mundo:
        //f·x_w = d, com x_w = A·x_l + t  →  (Aᵀ·f)·x_l = d - f·t. Ou seja,
        //n = Aᵀ·f (colunas de A escalarizadas com f; column-major: coluna
        //i = m[4i..4i+2]). NÃO normalizamos n de propósito: assim n·x_l é
        //a profundidade de MUNDO ao longo da view (a menos da constante),
        //e planos igualmente espaçados em n·x_l ficam igualmente espaçados
        //em profundidade real mesmo com escala não-uniforme no nó.
        const m = this.node.worldMatrix;
        const nx = m[0] * fx + m[1] * fy + m[2] * fz;
        const ny = m[4] * fx + m[5] * fy + m[6] * fz;
        const nz = m[8] * fx + m[9] * fy + m[10] * fz;

        //faixa de profundidades ocupada pela caixa: projeção dos 8 cantos
        let tMin = Infinity;
        let tMax = -Infinity;
        for (const [cx, cy, cz] of CORNERS) {
            const t = nx * cx + ny * cy + nz * cz;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
        }

        //normal unitária local, só pra base angular da ordenação do polígono
        const nlen = Math.hypot(nx, ny, nz);
        const ux = nx / nlen, uy = ny / nlen, uz = nz / nlen;

        const step = (tMax - tMin) / this.sliceCount;
        for (let i = 0; i < this.sliceCount; i++) {
            //fatia i = i-ésimo plano DE TRÁS PRA FRENTE: n aponta pra longe
            //da câmera, então t maior = mais longe → começa em tMax.
            //(i + 0.5) = centro do slab, os planos não encostam nas faces.
            const t = tMax - (i + 0.5) * step;
            this.writeSlice(this.meshes[i], t, nx, ny, nz, ux, uy, uz);
        }
    }

    /** Interseção plano(n·x = t) × caixa → polígono → 6 vértices no scratch → GPU. */
    private writeSlice(
        mesh: SliceMesh,
        t: number,
        nx: number, ny: number, nz: number,
        ux: number, uy: number, uz: number,
    ): void {
        //pontos de interseção do plano com as 12 arestas
        const pts: [number, number, number][] = [];
        for (const [a, b] of EDGES) {
            const [ax, ay, az] = CORNERS[a];
            const [bx, by, bz] = CORNERS[b];
            const fa = nx * ax + ny * ay + nz * az - t;
            const fb = nx * bx + ny * by + nz * bz - t;
            if ((fa < 0) === (fb < 0)) {
                continue; //aresta inteira do mesmo lado do plano
            }
            const s = fa / (fa - fb); //fração ao longo da aresta, em [0, 1]
            pts.push([ax + (bx - ax) * s, ay + (by - ay) * s, az + (bz - az) * s]);
        }

        this.scratch.fill(0);
        if (pts.length >= 3) {
            //ordena os pontos em volta do centroide, numa base (e1, e2) do
            //plano — polígono convexo, então a ordenação angular fecha ele
            let gx = 0, gy = 0, gz = 0;
            for (const [px, py, pz] of pts) {
                gx += px; gy += py; gz += pz;
            }
            gx /= pts.length; gy /= pts.length; gz /= pts.length;

            let e1x = pts[0][0] - gx, e1y = pts[0][1] - gy, e1z = pts[0][2] - gz;
            const e1len = Math.hypot(e1x, e1y, e1z) || 1;
            e1x /= e1len; e1y /= e1len; e1z /= e1len;
            //e2 = n × e1 (n unitária) — completa a base ortonormal do plano
            const e2x = uy * e1z - uz * e1y;
            const e2y = uz * e1x - ux * e1z;
            const e2z = ux * e1y - uy * e1x;

            pts.sort((p, q) => {
                const pa = Math.atan2(
                    (p[0] - gx) * e2x + (p[1] - gy) * e2y + (p[2] - gz) * e2z,
                    (p[0] - gx) * e1x + (p[1] - gy) * e1y + (p[2] - gz) * e1z,
                );
                const qa = Math.atan2(
                    (q[0] - gx) * e2x + (q[1] - gy) * e2y + (q[2] - gz) * e2z,
                    (q[0] - gx) * e1x + (q[1] - gy) * e1y + (q[2] - gz) * e1z,
                );
                return pa - qa;
            });

            //6 slots: polígono com k < 6 repete o último vértice (área zero)
            for (let j = 0; j < SliceMesh.VERTS; j++) {
                const [px, py, pz] = pts[Math.min(j, pts.length - 1)];
                const o = j * SliceMesh.FLOATS_PER_VERTEX;
                this.scratch[o] = px;
                this.scratch[o + 1] = py;
                this.scratch[o + 2] = pz;
                //uvw = posição na caixa [-0.5, 0.5]³ remapeada pra [0, 1]³
                this.scratch[o + 3] = px + 0.5;
                this.scratch[o + 4] = py + 0.5;
                this.scratch[o + 5] = pz + 0.5;
            }
        }
        //k < 3 (plano fora da caixa, casos-limite): scratch zerado = tudo
        //no mesmo ponto = nada desenhado
        mesh.updateVertices(this.scratch);
    }
}
