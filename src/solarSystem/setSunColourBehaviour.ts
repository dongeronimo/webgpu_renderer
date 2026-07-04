import { Behaviour } from "../behaviour";
import { UnshadedOpaque } from "../material";

function randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}
export class SetSunColourBehaviour extends Behaviour {

    update(deltaTime: number): void {
        const mat = this.node.renderable!.material; 
        if (mat instanceof UnshadedOpaque){
            mat.setColor(randomRange(0.9, 1.0), randomRange(0.9, 1.0), 0, 1);           
        }
    }

}
