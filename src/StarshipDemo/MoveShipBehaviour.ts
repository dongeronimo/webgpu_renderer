import { vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";


export class MoveShipBehaviour extends Behaviour {
    private velocity = vec3.create(0, 0, 100);
    update(deltaTime: number): void {
        this.node.position[0] += this.velocity[0] * deltaTime;
        this.node.position[1] += this.velocity[1] * deltaTime;
        this.node.position[2] += this.velocity[2] * deltaTime;
    }
    
}