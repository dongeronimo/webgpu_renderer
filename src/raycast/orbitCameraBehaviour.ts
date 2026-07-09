//Câmera orbital: posiciona o nó da câmera em coordenadas esféricas ao redor
//de um alvo (a mesh base do volume, na origem) e o faz olhar pra ele. Só
//mexe no nó da câmera — nada mais na cena.
//
//NÃO trata input: lê o estado {yaw, pitch, radius} do redux no update() e
//aplica. Quem entende o mouse é a camada React (OrbitControls), que despacha
//ORBIT_CAMERA/ZOOM_CAMERA — o mesmo canal UI→engine das outras behaviours.
//O reducer clampa o pitch a ±89°, então o lookAt nunca cai na degenerescência
//do polo (o "gimbal lock"); a rotação em si é um quaternion (Node.lookAt via
//cameraAim), sem ângulos de Euler no caminho.
import { vec3, type Vec3 } from "wgpu-matrix";
import { Behaviour } from "../behaviour";
import { store } from "../redux/store";

export class OrbitCameraBehaviour extends Behaviour {
    private readonly target: Vec3;
    //lastSeen: só reposiciona quando a órbita muda (NaN força o 1º frame).
    private lastYaw = NaN;
    private lastPitch = NaN;
    private lastRadius = NaN;

    constructor(target: Vec3 = vec3.create(0, 0, 0)) {
        super();
        this.target = target;
    }

    update(_deltaTime: number): void {
        const { yaw, pitch, radius } = store.getState().camera;
        if (yaw === this.lastYaw && pitch === this.lastPitch && radius === this.lastRadius) {
            return;
        }
        this.lastYaw = yaw;
        this.lastPitch = pitch;
        this.lastRadius = radius;
        //Esféricas → cartesianas. yaw gira em torno do +Y do mundo; pitch é a
        //elevação (clampada no reducer). yaw=0 põe a câmera no +Z, olhando -Z.
        const cp = Math.cos(pitch);
        const x = this.target[0] + radius * cp * Math.sin(yaw);
        const y = this.target[1] + radius * Math.sin(pitch);
        const z = this.target[2] + radius * cp * Math.cos(yaw);
        vec3.set(x, y, z, this.node.position);
        this.node.lookAt(this.target);
    }
}
