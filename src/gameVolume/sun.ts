//O SOL do gameVolume: a luz da cena tratada como DIRECIONAL (paralela).
//A luz de ponto do estágio anterior já estava tão longe (dist ~192) que a
//atenuação era ~constante — ou seja, já se comportava como sol. Formalizar
//isso destrava as sombras: uma luz direcional precisa de UM shadow map com
//projeção ORTOGRÁFICA, enquanto uma point light precisaria de um cube map
//(6 faces = 6 passes) — caro demais pra quinta-feira.
//
//O node da luz continua orbitando (OrbitLightBehaviour intacta): daqui sai só
//a DIREÇÃO (node → alvo). As matrizes de light-space (view ortho olhando ao
//longo dessa direção) são calculadas UMA vez por frame pelo mundo e
//compartilhadas por todos os passes que falam de sombra — shadow map,
//transmitância da fumaça, geometria e o próprio volume — pra todo mundo
//concordar sobre "onde a luz está".
import { mat4, vec3, type Mat4, type Vec3 } from "wgpu-matrix";

/** Tudo que os passes precisam saber sobre o sol neste frame. */
export interface Sun {
    /** Direção de PROPAGAÇÃO da luz (do sol PARA a cena), normalizada, mundo. */
    dir: Vec3;
    /** proj(ortho) * view da "câmera de luz" — leva mundo → clip de light-space. */
    viewProj: Mat4;
    /** Cor da luz (linear). */
    color: [number, number, number];
    /** Intensidade escalar (multiplica a cor). */
    intensity: number;
}

/**
 * Monta direção + viewProj do sol a partir da posição do node da luz.
 * `halfExtent` é o semi-lado da caixa ortho (tem que cobrir a cena inteira —
 * o que ficar fora não recebe nem projeta sombra); `eyeDist`/`near`/`far`
 * posicionam o "olho virtual" recuado ao longo da direção, com folga.
 */
export function buildSunMatrices(
    lightPos: Vec3,
    target: Vec3,
    halfExtent = 4.5,
    eyeDist = 20,
    near = 0.1,
    far = 40,
): { dir: Vec3; viewProj: Mat4 } {
    const dir = vec3.normalize(vec3.subtract(target, lightPos));
    //Olho recuado contra a direção de propagação; up fixo (0,1,0) é seguro
    //porque a órbita da luz tem elevação constante (~51°), nunca a pino.
    const eye = vec3.addScaled(target, dir, -eyeDist);
    const view = mat4.lookAt(eye, target, vec3.create(0, 1, 0));
    const proj = mat4.ortho(-halfExtent, halfExtent, -halfExtent, halfExtent, near, far);
    return { dir, viewProj: mat4.multiply(proj, view) };
}
