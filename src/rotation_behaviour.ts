import { Vec3 } from "wgpu-matrix";
import { Behaviour } from "./behaviour";

export class RotationBehaviour extends Behaviour {
    readonly rotationSpeed = 30.0;

    update(deltaTime: number): void {
        const angles:Vec3 = this.node.eulerAngles;
        angles[1] = angles[1]+this.rotationSpeed * deltaTime;
        this.node.eulerAngles = angles;
    }

}