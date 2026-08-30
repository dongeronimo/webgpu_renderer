//O overlay do LASSO: a mecânica do gesto vem do ContourCaptureOverlay, e o que
//é do lasso mora aqui — a cor e o que fazer com o contorno fechado.
import { useDispatch } from "react-redux";
import type { Mat4 } from "wgpu-matrix";
import { lassoAdded } from "../../redux/actions";
import type { AppDispatch } from "../../redux/store";
import type { RaycastLassoWorld } from "../../raycastLasso/raycastLassoWorld";
import { nextLassoId } from "../../raycastLasso/lassoData";
import { ContourCaptureOverlay } from "./ContourCaptureOverlay";

//Azul da paleta dos componentes.
const INK = "#7ab8ff";
const FILL = "rgba(122, 184, 255, 0.15)";

export function LassoCaptureOverlay({ world }: { world: RaycastLassoWorld }) {
    const dispatch = useDispatch<AppDispatch>();

    function onCommit(points: Float32Array, clipFromLocal: Mat4) {
        dispatch(lassoAdded({ id: nextLassoId(), points, clipFromLocal }));
    }

    return <ContourCaptureOverlay world={world} ink={INK} fill={FILL} onCommit={onCommit} />;
}
