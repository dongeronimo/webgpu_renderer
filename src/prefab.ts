//Prefab: um template de subárvore de Node que pode ser instanciado N vezes
//em runtime. Cada instância é uma cópia PROFUNDA da estrutura (nós,
//transform, renderables, behaviours) mas COMPARTILHA os assets de GPU
//(Mesh, Material) — igual à Unity, que compartilha o material asset por
//default.
//
//O Prefab NUNCA é dono dos assets: quem os destrói continua sendo o World
//(ou, no futuro, um AssetPool de vida longa). É por isso que a mesma classe
//serve guardada per-world (hoje) ou global (quando os assets forem globais)
//— "per-world vs global" vira só uma questão de ONDE se guarda o Prefab e
//onde vivem seus assets, não de redesign.
//
//A clonagem é o núcleo. Um Map original→clone é preenchido numa passada
//estrutural e consumido numa segunda passada, quando as behaviours são
//clonadas — é assim que uma referência de nó DENTRO do prefab acaba
//apontando pro nó da CÓPIA, não do template.

import { Node } from "./node";
import { Renderable } from "./renderable";
import { Camera } from "./camera";
import type { GltfLoadResult } from "./gltfLoader";
import type { World } from "./world";

export class Prefab {
    private constructor(
        /** Raiz do template. Fica DESTACADA — nunca entra num world vivo. */
        readonly template: Node,
        readonly name: string,
    ) {}

    /**
     * De uma subárvore montada em código. O Prefab passa a referenciar essa
     * árvore como template — não a copie de novo depois, monte-a só pra isto.
     */
    static fromTemplate(root: Node, name: string): Prefab {
        return new Prefab(root, name);
    }

    /**
     * De um GLB já carregado — reaproveita o loader como fonte de template.
     * As roots do resultado viram filhas de um nó-holder que é a raiz do
     * template. Os assets (meshes/materiais) continuam sendo do World.
     */
    static fromGltf(result: GltfLoadResult, name: string): Prefab {
        const holder = new Node();
        holder.name = name;
        for (const root of result.roots) {
            root.setParent(holder);
        }
        return new Prefab(holder, name);
    }

    /**
     * Uma cópia fresca e destacada. O chamador a parenteia onde quiser.
     *
     * `world` é injetado em `.world` de cada nó da cópia ANTES do start(),
     * pra que uma behaviour possa usar `this.node.world` já no start (ex.: a
     * ShipLifecycle agenda a própria destruição). Passe o World que vai
     * receber a instância; `null` deixa `.world` nulo (nó fora de mundo).
     */
    instantiate(world: World | null = null): Node {
        return cloneSubtree(this.template, world);
    }
}

/**
 * Clona uma subárvore de Node inteira e devolve a raiz do clone, destacada.
 * Assets de GPU (Mesh, Material) são compartilhados por referência; todo o
 * resto é copiado. As referências de nó guardadas nas behaviours são
 * remapeadas pros nós da cópia.
 */
export function cloneSubtree(src: Node, world: World | null = null): Node {
    const map = new Map<Node, Node>();
    //Passe 1: estrutura + componentes (+ .world). Preenche o map original→clone.
    const root = cloneStructure(src, map, world);
    //Passe 2: referências entre nós. Só agora o map está COMPLETO, então dá
    //pra remapear qualquer referência a nó do prefab com segurança.
    for (const [orig, clone] of map) {
        //Skin: os ossos são Nodes; a cópia tem que apontar pros ossos da
        //CÓPIA, não do template (senão duas instâncias dividem esqueleto e a
        //segunda "puxa" a pose da primeira). As inverseBindMatrices, sendo
        //constantes do asset, continuam compartilhadas.
        if (orig.skin) {
            clone.skin = orig.skin.clone(map);
        }
        for (const behaviour of orig.behaviours) {
            const copy = behaviour.clone(map);
            copy.node = clone;
            clone.behaviours.push(copy);
        }
    }
    //Passe 3: start() — árvore montada, refs resolvidas. Via
    //callStartIfHaventYet (não start() direto) pra marcar o flag: assim o
    //callStartIfHaventYet do World.update, no primeiro frame da instância,
    //vira no-op em vez de disparar um SEGUNDO start.
    for (const clone of map.values()) {
        for (const behaviour of clone.behaviours) {
            behaviour.callStartIfHaventYet();
        }
    }
    return root;
}

function cloneStructure(src: Node, map: Map<Node, Node>, world: World | null): Node {
    const node = new Node();
    node.name = src.name;
    node.world = world; //injetado (não copiado do template): a instância é deste mundo
    node.copyLocalFrom(src);
    node.extras = structuredClone(src.extras);
    if (src.renderable) {
        node.renderable = cloneRenderable(src.renderable);
    }
    if (src.camera) {
        node.camera = cloneCamera(src.camera);
    }
    map.set(src, node);
    for (const child of src.children) {
        cloneStructure(child, map, world).setParent(node);
    }
    return node;
}

//Mesh e Material são compartilhados por referência (assets de GPU); só o
//objeto Renderable é novo, com seu passMask próprio.
function cloneRenderable(src: Renderable): Renderable {
    const renderable = new Renderable(src.mesh);
    renderable.material = src.material;
    renderable.passMask = src.passMask;
    return renderable;
}

function cloneCamera(src: Camera): Camera {
    const camera = new Camera();
    camera.fovY = src.fovY;
    camera.aspect = src.aspect;
    camera.near = src.near;
    camera.far = src.far;
    return camera;
}

/**
 * Tira uma instância de cena: roda dispose() das behaviours (libera estado
 * por-instância, ex.: buffers de GPU que a behaviour criou) e destaca a
 * raiz. NÃO destrói Mesh/Material — são compartilhados e continuam sendo do
 * World. Depois disto, o GC recolhe os Nodes/Renderables/Behaviours.
 */
export function destroyInstance(root: Node): void {
    const visit = (node: Node): void => {
        for (const behaviour of node.behaviours) {
            behaviour.dispose();
        }
        //cópia dos filhos: dispose() não deveria mexer na árvore, mas iterar
        //sobre um snapshot é barato e à prova de quem o fizer
        for (const child of [...node.children]) {
            visit(child);
        }
    };
    visit(root);
    root.setParent(null);
}

/**
 * Primeiro nó com esse nome DENTRO da subárvore (inclui a raiz). É o lookup
 * escopo-de-instância: o World.findNode busca do ROOT e pega o primeiro de
 * TODAS as instâncias; este parte de um root de instância, então acha o nó
 * certo daquela cópia. Útil pra behaviours resolverem irmãos no start().
 */
export function findInSubtree(root: Node, name: string): Node | null {
    if (root.name === name) {
        return root;
    }
    for (const child of root.children) {
        const found = findInSubtree(child, name);
        if (found) {
            return found;
        }
    }
    return null;
}
