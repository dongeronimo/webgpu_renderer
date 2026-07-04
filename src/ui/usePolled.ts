//O canal engine→UI para estado POR-FRAME (posições, fps...): a UI puxa no
//ritmo que quiser, a engine nem sabe que está sendo observada. É o dual do
//canal UI→engine, que é o dispatch no Redux (intenção, baixa frequência).
//
//Por que pull e não push+throttle: o consumidor dita a taxa (componente
//desmontado = polling parou sozinho), e não existe subscription na engine
//pra vazar depois do destroy() de um mundo.
import { useEffect, useRef, useState } from "react";

/**
 * Lê `read()` `hz` vezes por segundo e devolve o último valor.
 * `read` DEVE devolver snapshot (array/objeto novos), não referência viva:
 * as matrizes da engine são mutadas in place, e referência repetida faria
 * o React achar que nada mudou.
 */
export function usePolled<T>(read: () => T, hz = 4): T {
    //ref pro read mais recente: o interval só depende de hz, sem ser
    //recriado a cada render por causa de arrow function nova
    const readRef = useRef(read);
    readRef.current = read;
    const [value, setValue] = useState<T>(read);
    useEffect(() => {
        const id = setInterval(() => setValue(readRef.current()), 1000 / hz);
        return () => clearInterval(id);
    }, [hz]);
    return value;
}
