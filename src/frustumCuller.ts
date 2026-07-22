//FrustumCuller: extrai os 6 planos do frustum a partir da matriz combinada
//proj*view (mundo→clip) e testa AABBs/pontos de mundo contra eles, com uma
//margem de segurança opcional (expande o frustum pra fora por N unidades —
//evita pop-in/out perceptível nas bordas). Objeto helper GENÉRICO: qualquer
//render pass pode ter o seu, sem reescrever a extração de planos — mas CADA
//pass decide o que culla e com que margem (é ele quem conhece sua técnica).
//
//Convenção: mundo→clip é column-major (mesma de Node/Camera — translação
//nos índices 12-14), aplicada como M*v (v vetor coluna), e o clip.z do
//WebGPU vive em [0,1] (não [-1,1] do OpenGL) — as fórmulas de near/far
//abaixo já assumem isso (ver o comentário de Camera.getProjectionMatrix).
import { type Mat4, type Vec3 } from "wgpu-matrix";

const PLANE_COUNT = 6;
const FLOATS_PER_PLANE = 4; //(nx, ny, nz, d) por plano

export class FrustumCuller {
    //6 planos left,right,bottom,top,near,far, cada um (nx,ny,nz,d) normalizado,
    //testado como dot(normal,p)+d >= 0 ⟺ dentro. Zerado até a 1ª update():
    //nesse estado todo plano vira (0,0,0,0), e o teste abaixo (0+margem<0 é
    //sempre falso) devolve "visível" pra tudo — falha aberta, nunca culla
    //antes de ter uma matriz de verdade.
    private readonly planes = new Float32Array(PLANE_COUNT * FLOATS_PER_PLANE);

    /** Recalcula os 6 planos a partir da matriz combinada proj*view (mundo→clip). */
    update(viewProj: Mat4): void {
        const m = viewProj;
        //Gribb-Hartmann adaptado pra matriz column-major (clip = M*v) com
        //profundidade WebGPU em [0,1]: a "linha i" de M no sentido algébrico
        //(a que multiplica v pra dar clip[i]) é (m[i], m[i+4], m[i+8], m[i+12])
        //— não uma linha contígua do array, porque ele guarda M por COLUNAS.
        this.setPlane(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]); //left:   x_ndc >= -1
        this.setPlane(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]); //right:  x_ndc <=  1
        this.setPlane(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]); //bottom: y_ndc >= -1
        this.setPlane(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]); //top:    y_ndc <=  1
        this.setPlane(4, m[2], m[6], m[10], m[14]);                             //near:   z_ndc >=  0
        this.setPlane(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); //far:   z_ndc <=  1
    }

    private setPlane(i: number, a: number, b: number, c: number, d: number): void {
        //normaliza por |normal| — é isso que faz "d" virar distância de
        //verdade em unidades de mundo, o que permite somar uma margem em
        //unidades de mundo na hora de testar (ver intersectsAABB).
        const len = Math.hypot(a, b, c) || 1;
        const base = i * FLOATS_PER_PLANE;
        this.planes[base + 0] = a / len;
        this.planes[base + 1] = b / len;
        this.planes[base + 2] = c / len;
        this.planes[base + 3] = d / len;
    }

    /**
     * true se a AABB de mundo [min,max] intersecta o frustum expandido por
     * `margin` unidades pra fora em cada plano (a "margem de segurança").
     * Teste do "vértice positivo": se o canto da AABB mais favorável a um
     * plano ainda está do lado de fora dele, a AABB inteira está — pode dar
     * falso positivo perto das quinas do frustum (culla menos do que podia),
     * nunca falso negativo (nunca some algo que devia aparecer).
     */
    intersectsAABB(min: Vec3, max: Vec3, margin: number = 0): boolean {
        for (let i = 0; i < PLANE_COUNT; i++) {
            const base = i * FLOATS_PER_PLANE;
            const nx = this.planes[base + 0];
            const ny = this.planes[base + 1];
            const nz = this.planes[base + 2];
            const d = this.planes[base + 3];
            const px = nx >= 0 ? max[0] : min[0];
            const py = ny >= 0 ? max[1] : min[1];
            const pz = nz >= 0 ? max[2] : min[2];
            if (nx * px + ny * py + nz * pz + d + margin < 0) {
                return false; //fora deste plano: a AABB inteira está fora do frustum
            }
        }
        return true;
    }

    /** Atalho pra testar um ponto (ex.: posição de uma luz) — AABB degenerada. */
    containsPoint(point: Vec3, margin: number = 0): boolean {
        return this.intersectsAABB(point, point, margin);
    }
}
