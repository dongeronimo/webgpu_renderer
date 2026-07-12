//Move o nó da luz numa órbita horizontal ao redor de `center`, acumulando o
//ângulo por deltaTime. A luz precisa ser filha DIRETA do root (posição local
//== mundo) porque o MainRenderPass lê a posição LOCAL do nó de luz — um pivô
//girando não funcionaria, ele veria a posição local constante do filho.
//
//Anima a iluminação da geometria (o "muda em tempo real" também vale pro lado
//opaco) e deixa a luz em movimento pronta pras sombras dinâmicas dos próximos
//estágios (geometria projeta no volume; volume projeta na geometria).
import { vec3, type Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";

export class OrbitLightBehaviour extends Behaviour {
    private angle: number;

    constructor(
        private readonly center: Vec3 = vec3.create(0, 0, 0),
        private readonly radius = 3.5,
        private readonly height = 3.0,
        /** rad/s — velocidade angular da órbita. */
        private readonly speed = 0.5,
        startAngle = 0,
    ) {
        super();
        this.angle = startAngle;
    }

    update(deltaTime: number): void {
        this.angle += this.speed * deltaTime;
        vec3.set(
            this.center[0] + this.radius * Math.cos(this.angle),
            this.center[1] + this.height,
            this.center[2] + this.radius * Math.sin(this.angle),
            this.node.position,
        );
    }
}
