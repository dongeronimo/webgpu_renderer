import { Node } from "./node";
import { destroyRegisteredMaterials } from "./material";
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
        const visit = (node:Node) => {
            for (const behaviour of node.behaviours) {
                behaviour.update(deltaTime);
            }
            node.updateWorldMatrix();
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(this.rootNode);
    }
};