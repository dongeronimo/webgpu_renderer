//Painel modal genérico: backdrop cobrindo o container inteiro (centraliza
//o conteúdo por flex) + chrome do FloatingPanel (TitleBar, mesma paleta),
//sem drag nem minimize — ao contrário do FloatingPanel, este captura o
//mouse na área INTEIRA (não só no chrome), então nada atravessa pro canvas
//enquanto ele estiver aberto. Pensado pra fluxos que precisam travar a tela
//(ex: escolha de personagem antes de entrar no jogo).
import { useEffect } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import styles from "./ModalPanel.module.css";

//Omit de "title" pelo mesmo motivo do FloatingPanel: o title?:string
//nativo (tooltip) colidiria com o nosso.
export type ModalPanelProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
    title: ReactNode;
    icon?: ReactNode;
    actions?: ReactNode;
    width?: CSSProperties["width"];
    height?: CSSProperties["height"];
    //ausente = modal não dispensável (backdrop/Esc não fazem nada) — use
    //pra fluxos obrigatórios como a escolha de personagem. Presente = o
    //consumidor decide o que "fechar" significa (esconder, cancelar, etc.).
    onDismiss?: () => void;
    children: ReactNode;
};

export function ModalPanel({
    title,
    icon,
    actions,
    width,
    height,
    onDismiss,
    children,
    className,
    style,
    ...rest
}: ModalPanelProps) {
    useEffect(() => {
        if (!onDismiss) return;
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") onDismiss!();
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onDismiss]);

    const classes = [styles.panel, className].filter(Boolean).join(" ");
    return (
        <div
            className={styles.backdrop}
            //só dispensa se o clique começou no PRÓPRIO backdrop (o "vazio"
            //ao redor do painel) — clique dentro do painel não deve fechar
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onDismiss?.();
            }}
        >
            <div className={classes} style={{ width, height, ...style }} {...rest}>
                <TitleBar icon={icon} actions={actions}>
                    {title}
                </TitleBar>
                <div className={styles.content}>{children}</div>
            </div>
        </div>
    );
}
