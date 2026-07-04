//Demonstração do fluxo UI → engine: o botão da UI despacha HELLO_CLICKED
//no Redux, e esta behaviour reage — sem saber que React existe.
//
//Repare que não há subscribe: como behaviour já roda todo frame, ler o
//getState() no update() já é reativo por construção (o valor novo vale no
//frame seguinte ao dispatch) e não deixa callback pendurado no store
//depois do destroy() do mundo.
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";

export class HelloReactBehaviour extends Behaviour {
    private lastSeen = 0;

    update(_deltaTime: number): void {
        const { clickCount } = store.getState().hello;
        if (clickCount !== this.lastSeen) {
            this.lastSeen = clickCount;
            console.log(
                `HelloReactBehaviour (${this.node.name}): botão clicado ${clickCount} vez(es)`,
            );
        }
    }
}
