import { FloatingPanel } from "./generic/FloatingPanel";

export function TextureStackVolumeRenderUIRoot() {
    return (
        <FloatingPanel
            title="Volume Render (sintético)"
            width={260}
            height="auto"
            style={{ top: 8, left: 8 }}
        >
            HELLO TEXTURE STACK
        </FloatingPanel>
    );
}
