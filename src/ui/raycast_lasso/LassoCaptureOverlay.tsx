//O overlay do LASSO: a mecânica do gesto vem do ContourCaptureOverlay, e o que
//é do lasso mora aqui — a cor e o que fazer com o contorno fechado.
//
//ALT INVERTE: solto, o traço REMOVE o que está dentro; com Alt, MANTÉM só o que
//está dentro (crop). Modificador e não modo permanente porque crop é raro perto
//de remoção — e modo que você esquece que está ligado faz você sumir com o
//corpo inteiro achando que ia tirar uma costela. O overlay mostra qual é dos
//dois enquanto você arrasta, sombreando o que vai sumir.
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

    function onCommit(points: Float32Array, clipFromLocal: Mat4, inverted: boolean) {
        dispatch(lassoAdded({ id: nextLassoId(), points, clipFromLocal, keep: inverted }));
    }

    return (
        <ContourCaptureOverlay
            world={world}
            ink={INK}
            fill={FILL}
            altInverts
            onCommit={onCommit}
        />
    );
}
