import { Node } from "./node";
/**
 * O mundo tem um nó raiz chamado ROOT.
 * É uma classe abstrata - cada mundo tem que implementar seu createWorld.
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
     * Cria o mundo. Cada mundo vai ter uma implementação diferente disso.
     */
    abstract createWorld(perspective:{
        aspect:number, fovy:number, near:number, far:number
    }):Promise<void>;
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