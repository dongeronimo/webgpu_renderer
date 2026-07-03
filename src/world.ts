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
     * Percorre a árvore do mundo, invocando os Behaviour de cada Node
     * TODO: Implementar, nem existe Behaviour
    */
    public update(_:number) {
        //TODO: Não implementado
    }
};