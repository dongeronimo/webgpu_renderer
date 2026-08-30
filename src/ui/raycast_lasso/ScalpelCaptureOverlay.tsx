//O overlay do BISTURI. Mesmo gesto do lasso (ContourCaptureOverlay), mas o
//contorno fechado vira outra coisa: um ScalpelData, que carrega a espessura do
//descasque e dispara a captura do mapa de profundidade no material.
//
//Verde-piscina, a cor da ferramenta — a mesma do debug no shader, pra o traço
//na tela e a região pintada serem obviamente a mesma coisa.
import { useDispatch, useSelector } from "react-redux";
import type { Mat4 } from "wgpu-matrix";
import { scalpelAdded } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import type { RaycastLassoWorld } from "../../raycastLasso/raycastLassoWorld";
import { nextScalpelId } from "../../raycastLasso/scalpelData";
import { ContourCaptureOverlay } from "./ContourCaptureOverlay";

const INK = "#00d9c7";
const FILL = "rgba(0, 217, 199, 0.15)";

export function ScalpelCaptureOverlay({ world }: { world: RaycastLassoWorld }) {
    const dispatch = useDispatch<AppDispatch>();
    //A margem é lida NO MOMENTO do commit e congelada no dado: mexer no slider
    //depois não muda os cortes já feitos, como o tamanho de um pincel.
    const margin = useSelector((state: RootState) => state.scalpel.margin);
    //A CTF vai junto no dado, congelada como a câmera: é ela que define o que
    //conta como superfície, e sem ela o corte não seria reproduzível.
    const ctf = useSelector((state: RootState) => state.ctf.points);

    function onCommit(points: Float32Array, clipFromLocal: Mat4) {
        dispatch(scalpelAdded({ id: nextScalpelId(), points, clipFromLocal, margin, ctf }));
    }

    return <ContourCaptureOverlay world={world} ink={INK} fill={FILL} onCommit={onCommit} />;
}
