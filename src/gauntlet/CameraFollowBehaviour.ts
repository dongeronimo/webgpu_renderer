import { vec3, type Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { Node } from "../node";

/**
 * Anexada na câmera; persegue `target` (o pivot do avatar local) com um
 * offset fixo, todo frame. Só existe pro player LOCAL — nunca é clonada por
 * prefab (attach é sempre programático, pós-fabricate), então o ctor com
 * argumentos obrigatórios é seguro (ver nota da MineAvatarBehaviour).
 */
export default class CameraFollowBehaviour extends Behaviour {
    private readonly target: Node;
    private readonly offset: Vec3;

    constructor(target: Node, offset: Vec3) {
        super();
        this.target = target;
        this.offset = offset;
    }

    update(): void {
        vec3.add(this.target.position, this.offset, this.node.position);
        this.node.lookAt(this.target.position);
    }
}
