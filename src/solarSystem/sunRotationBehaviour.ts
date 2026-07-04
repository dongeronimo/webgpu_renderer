import { Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";

export class SolRotationBehaviour extends Behaviour {
    readonly rotationSpeed = 120.0;

    update(deltaTime: number): void {
        const angles:Vec3 = this.node.eulerAngles;
        angles[1] = angles[1]+this.rotationSpeed * deltaTime;
        this.node.eulerAngles = angles;
    }

}
