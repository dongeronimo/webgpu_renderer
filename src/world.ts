import { Node } from "./node";
import { destroyRegisteredMaterials } from "./material";
import { destroyInstance } from "./prefab";
/**
 * O mundo tem um nó raiz chamado ROOT e é dono da própria sequência de
 * render passes — cada mundo renderiza de um jeito (este com mesh+final,
 * outro com cubemap+shadow+gbuffer..., o volume renderer com volume pass),
 * então a cadeia não pode morar no main.
 *
 * Ciclo de vida (quem chama é o main):
 *   1. new             — só guarda device e cria a raiz;
 *   2. createRenderPasses(canvas, format) — infra de renderização do mundo;
 *   3. createWorld(perspective)           — conteúdo (assets, materiais, câmera);
 *   4. por frame: update(dt) e depois render(encoder);
 *   5. destroy()       — libera GPU e solta o canvas; com tudo autocontido
 *      assim, trocar de "fase" é destroy() num mundo e 1–3 no próximo.
 */
export abstract class World {
    protected rootNode:Node;
    protected readonly device:GPUDevice;
    /**
     * Cria o mundo. 
     */
    constructor(device:GPUDevice){
        this.rootNode = new Node();
        this.rootNode.name = "ROOT";
        //O ROOT é do mundo por definição: garante .world nele desde já, pra
        //que behaviours anexadas ao root (ex.: um spawner) achem o World —
        //elas não passam pelo caminho que seta .world nos nós com behaviour.
        this.rootNode.world = this;
        this.device = device;
    }
    /** Raiz da árvore de cena — é daqui que os render passes percorrem o mundo. */
    public get root(): Node {
        return this.rootNode;
    }
    /**
     * Primeiro nó com esse nome, ou null. É o caminho de LEITURA da UI:
     * o scene graph é a fonte do estado por-frame, e a UI o consulta por
     * nome a cada poll — de propósito, em vez de cachear a referência do
     * Node, que viraria dangling depois do destroy() numa troca de mundo.
     * Busca O(n); se um dia doer, o World mantém um Map name→Node.
     */
    public findNode(name: string): Node | null {
        const visit = (node: Node): Node | null => {
            if (node.name === name) {
                return node;
            }
            for (const child of node.children) {
                const found = visit(child);
                if (found) {
                    return found;
                }
            }
            return null;
        };
        return visit(this.rootNode);
    }
    /**
     * Versão FLAT (achatada) da árvore: todos os nós do mundo numa lista só,
     * em ordem de pré-fixo (pai antes dos filhos). Inclui o ROOT. É uma
     * cópia nova a cada chamada — mutar a lista não afeta a hierarquia, mas
     * os Node dentro dela são as referências reais.
     */
    public getAllNodes(): Node[] {
        const result: Node[] = [];
        const visit = (node: Node): void => {
            result.push(node);
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(this.rootNode);
        return result;
    }
    private scheduledNodesForDestruction:Node[] = [];
    /**
     * Tira `node` e toda a subárvore dele de cena: roda dispose() das
     * behaviours de cada nó (libera estado por-instância, ex.: buffers de GPU
     * que a behaviour criou) e destaca `node` do pai. NÃO destrói Mesh/Material
     * — são compartilhados e continuam sendo do World. Depois disto o GC
     * recolhe os Nodes/Renderables/Behaviours. Reutiliza o mesmo caminho da
     * remoção de instância de prefab.
     */
    public destroyNode(node: Node, immediate:boolean=false): void {
        if(immediate)
            destroyInstance(node);
        else
            this.scheduledNodesForDestruction.push(node);
    }
    /**
     * Cria a infra de renderização DESTE mundo: os render passes e a
     * fiação entre eles. Par do createWorld — uma cria como se desenha,
     * a outra cria o que se desenha. Chamada antes do createWorld.
     */
    abstract createRenderPasses(canvas:HTMLCanvasElement, canvasFormat:GPUTextureFormat):void;
    /**
     * Cria o mundo. Cada mundo vai ter uma implementação diferente disso.
     */
    abstract createWorld(perspective:{
        aspect:number, fovy:number, near:number, far:number
    }):Promise<void>;
    /**
     * Grava a sequência de render passes do mundo no encoder, na ordem que
     * ESTE mundo quer. O main só faz encoder/submit — não conhece os passes.
     */
    abstract render(encoder:GPUCommandEncoder):void;
    /**
     * Libera os recursos de GPU do mundo (meshes, materiais, passes) e
     * solta o canvas. A base cuida dos materiais registrados (o registry é
     * global — o próximo mundo não pode herdá-lo); cada mundo sobrescreve
     * pra destruir seus passes e meshes, chamando super.destroy().
     */
    public destroy():void {
        destroyRegisteredMaterials();
    }
    /**
     * Percorre a árvore do mundo UMA vez, fazendo as duas coisas do frame:
     * invoca os Behaviour de cada Node e atualiza o cache de worldMatrix
     * (top-down, O(n) no total — cada nó faz uma multiplicação).
     *
     * A ordem dentro de cada nó importa: as behaviours dele rodam ANTES da
     * matriz dele fechar, então mudanças que uma behaviour faz no próprio
     * nó (ou em descendentes) já valem neste frame. Mexer num ANCESTRAL
     * (que já fechou a matriz) só aparece no frame seguinte.
    */
    public update(deltaTime:number) {
        
        this.scheduledNodesForDestruction = [];
        const visit = (node:Node) => {
            for (const behaviour of node.behaviours) {
                behaviour.callStartIfHaventYet();
                behaviour.update(deltaTime);
            }
            node.updateWorldMatrix();
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(this.rootNode);
        //Agora que a travessia terminou, é seguro mexer na árvore: destrói de
        //fato (immediate=true) os nós agendados durante o frame.
        this.scheduledNodesForDestruction.forEach(n=>this.destroyNode(n, true));
    }
};