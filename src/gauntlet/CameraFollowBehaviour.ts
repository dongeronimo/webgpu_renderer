import { vec3, type Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { Node } from "../node";

/**
 * Anexada na câmera; persegue `target` (o pivot do avatar local) com um
 * offset fixo. Só existe pro player LOCAL — nunca é clonada por prefab (attach
 * é sempre programático, pós-fabricate), então o ctor com argumentos
 * obrigatórios é seguro (ver nota da MineAvatarBehaviour).
 *
 * Roda em lateUpdate (não update) de PROPÓSITO: a câmera fica em outra
 * subárvore que a travessia visita ANTES do avatar, então no update() ela leria
 * a target.position de um frame atrás — e o offset câmera↔avatar passaria a
 * carregar o deltaTime·v jittery, virando tremor dependente de frame rate
 * (mais visível quanto menor/mais instável o fps). No lateUpdate o avatar já
 * andou neste frame, o offset é constante e a câmera fica firme. (É a mesma
 * razão pela qual câmeras de follow moram no LateUpdate na Unity.)
 */
export default class CameraFollowBehaviour extends Behaviour {
    private readonly target: Node;
    private readonly offset: Vec3;

    constructor(target: Node, offset: Vec3) {
        super();
        this.target = target;
        this.offset = offset;
    }

    //update() é obrigatório (abstract na base), mas o follow tem que rodar
    //DEPOIS do avatar se mover — daí toda a lógica está no lateUpdate.
    update(): void {}

    override lateUpdate(): void {
        vec3.add(this.target.position, this.offset, this.node.position);
        this.node.lookAt(this.target.position);
    }
}
