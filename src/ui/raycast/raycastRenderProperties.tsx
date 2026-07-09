//Controles do renderer do mundo Raycaster. Por ora é só o painel flutuante,
//no mesmo molde do Render (CT) — os controles entram aqui conforme o
//raycaster ganha parâmetros (passo/qualidade, alpha, CTF, empty-space
//skipping, shading...). Fluxo UI→engine de sempre: cada controle despacha
//uma action; a behaviour-cérebro (VolumeRaycastBehaviour) lê no update().
import { FloatingPanel } from "../generic/FloatingPanel";

export default function RaycastRenderProperties() {
    return (
        <FloatingPanel title="Render (Raycaster)" width={260} height="auto" style={{ top: 8, left: 8 }}>
            {/* TODO: controles do raycaster entram aqui (Slider/Toggle → redux) */}
            <div style={{ opacity: 0.6 }}>sem controles ainda</div>
        </FloatingPanel>
    );
}
