//Camada invisível que capta o mouse pra orbitar/zoomar a câmera. Cobre o
//canvas inteiro com pointer-events:auto, mas é o PRIMEIRO filho do App
//(pinta ATRÁS dos painéis), então drag/scroll no "vazio" orbitam e nos
//painéis continuam sendo do painel.
//
//Aqui mora TODA a lógica de input: converte pixels→radianos e despacha
//ORBIT_CAMERA/ZOOM_CAMERA. A OrbitCameraBehaviour, do outro lado da
//fronteira, só lê o resultado no redux — sem listeners nem callbacks no
//engine (o canal UI→engine de sempre).
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { useDispatch } from "react-redux";
import { orbitCamera, zoomCamera } from "../redux/actions";
import type { AppDispatch } from "../redux/store";

//Sensibilidade do arrasto, em radianos por pixel.
const ORBIT_SENSITIVITY = 0.008;
//Fator de zoom por "entalhe" de scroll (aproxima/afasta multiplicando o raio).
const ZOOM_STEP = 1.1;

export function OrbitControls() {
    const dispatch = useDispatch<AppDispatch>();
    //ponteiro do arrasto em andamento — ref porque ninguém renderiza a partir
    //disso; só o pointermove lê pra calcular o delta desde o último evento
    const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        //captura: o move continua chegando mesmo se o ponteiro sair da camada
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        const d = drag.current;
        if (!d || e.pointerId !== d.pointerId) {
            return;
        }
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        //sinais escolhidos pra "arrastar leva a cena junto"; se ficar
        //invertido pro seu gosto, é só trocar o sinal aqui
        dispatch(orbitCamera(-dx * ORBIT_SENSITIVITY, -dy * ORBIT_SENSITIVITY));
    }

    function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId === e.pointerId) {
            drag.current = null;
        }
    }

    function onWheel(e: ReactWheelEvent<HTMLDivElement>) {
        //scroll pra cima (deltaY<0) aproxima = raio menor
        dispatch(zoomCamera(e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
    }

    return (
        <div
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "auto",
                touchAction: "none", //deixa o pointermove fluir no touch/trackpad
                cursor: "grab",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onWheel={onWheel}
        />
    );
}
