import { Behaviour } from "../behaviour";
import type { StarshipDemoWorld } from "./StarshipDemoWorld";

/**
 * Spawna uma nave a cada `interval` segundos. Fica anexado ao ROOT — que
 * vive o mundo inteiro —, então nunca é destruído junto com as naves que
 * cria. Descobre o mundo por `this.node.world` (a base seta isso no ROOT) e
 * chama o spawnStarship() dele.
 */
export class ShipSpawnerBehaviour extends Behaviour {
    /** Segundos entre spawns. */
    private interval = 1.0;
    /** Acumula dt; quando passa de `interval`, spawna e desconta o intervalo. */
    private timeSinceLastSpawn = 0;

    update(deltaTime: number): void {
        this.timeSinceLastSpawn += deltaTime;
        // while (não if): se um frame estourar o intervalo (ex.: hitch de
        // vários segundos), spawna o tanto atrasado em vez de perder spawns.
        // Descontar o intervalo (em vez de zerar) mantém a cadência média.
        while (this.timeSinceLastSpawn >= this.interval) {
            this.timeSinceLastSpawn -= this.interval;
            (this.node.world as StarshipDemoWorld).spawnStarship();
        }
    }
}
