import { Behaviour } from "../behaviour";

/**
 * Randomiza a posição da nave quando ela spawna e destrói ela depois de um tempo.
 */
export class ShipLifecycleBehaviour extends Behaviour {
    private randomRange(min:number, max:number) {
        return min + Math.random() * (max - min);
    }
    private timeElapsed = 0;
    start(): void {
        const x = this.randomRange(-300,10);
        const y = this.randomRange(-200,200);
        this.node.position[0] = x;
        this.node.position[1] = y
        this.node.position[2] = -1500;
    }

    update(deltaTime: number): void {
        this.timeElapsed += deltaTime;
        if(this.timeElapsed > 30.0){
            this.node.world!.destroyNode(this.node);
        }
    }

}