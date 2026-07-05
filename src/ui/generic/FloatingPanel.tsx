//Painel flutuante genérico: chrome (fundo, raio, sombra) + TitleBar com
//botão de minimizar/restaurar. Começa maximizado no tamanho máximo que o
//consumidor define via width/height; minimizado ele colapsa pra só a
//barra de título (mantendo a largura, pro painel não "pular" de lugar).
//Posição é responsabilidade do consumidor: passe style={{ top, right }}
//etc. — o .panel já é position:absolute e religa o pointer-events que o
//#ui-root desliga.
//Drag pela TitleBar: o arrasto vira um transform:translate por cima da
//posição inicial do consumidor — funciona igual com top/left ou top/right,
//sem converter coordenada nenhuma.
import { useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, PointerEvent, ReactNode } from "react";
import { Button } from "./Button";
import { TitleBar } from "./TitleBar";
import styles from "./FloatingPanel.module.css";

//Omit de "title" pelo mesmo motivo documentado na TitleBar: o title?:string
//nativo (tooltip) colidiria com o nosso e estreitaria o tipo pra string.
export type FloatingPanelProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
    title: ReactNode;
    icon?: ReactNode;
    //ações extras da TitleBar; o botão de minimizar é adicionado depois
    //delas, sempre na ponta direita
    actions?: ReactNode;
    //tamanho do estado maximizado (o inicial)
    width: CSSProperties["width"];
    height: CSSProperties["height"];
    children: ReactNode;
};

export function FloatingPanel({
    title,
    icon,
    actions,
    width,
    height,
    children,
    className,
    style,
    ...rest
}: FloatingPanelProps) {
    const [minimized, setMinimized] = useState(false);
    //Quanto o painel já foi arrastado desde a posição inicial do consumidor.
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    //Dados do arrasto em andamento — ref e não state porque só o
    //pointermove lê, ninguém renderiza a partir disso.
    const drag = useRef<{
        pointerId: number;
        //posição do ponteiro no pointerdown
        startX: number;
        startY: number;
        //dragOffset no momento do pointerdown
        baseX: number;
        baseY: number;
    } | null>(null);

    function onTitlePointerDown(e: PointerEvent<HTMLDivElement>) {
        //clique nas ações (minimizar etc.) é clique, não começo de arrasto
        if ((e.target as HTMLElement).closest("button")) {
            return;
        }
        drag.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseX: dragOffset.x,
            baseY: dragOffset.y,
        };
        //captura: o move continua chegando mesmo se o ponteiro sair da
        //barra (arrasto rápido) ou entrar no canvas
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onTitlePointerMove(e: PointerEvent<HTMLDivElement>) {
        const d = drag.current;
        if (!d || e.pointerId !== d.pointerId) {
            return;
        }
        setDragOffset({
            x: d.baseX + (e.clientX - d.startX),
            y: d.baseY + (e.clientY - d.startY),
        });
    }

    function onTitlePointerEnd(e: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId === e.pointerId) {
            drag.current = null;
        }
    }

    const classes = [styles.panel, className].filter(Boolean).join(" ");
    return (
        <div
            className={classes}
            style={{
                width,
                //height só quando maximizado — minimizado a altura é a da barra
                height: minimized ? undefined : height,
                ...style,
                //depois do ...style de propósito: o transform do drag não
                //pode ser soterrado pelo style do consumidor
                transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
            }}
            {...rest}
        >
            <TitleBar
                icon={icon}
                className={styles.dragHandle}
                onPointerDown={onTitlePointerDown}
                onPointerMove={onTitlePointerMove}
                onPointerUp={onTitlePointerEnd}
                onPointerCancel={onTitlePointerEnd}
                actions={
                    <>
                        {actions}
                        <Button
                            variant="ghost"
                            size="sm"
                            icon={<span>{minimized ? "▢" : "–"}</span>}
                            aria-label={minimized ? "Restaurar" : "Minimizar"}
                            onClick={() => setMinimized((m) => !m)}
                        />
                    </>
                }
            >
                {title}
            </TitleBar>
            {/*desmonta o conteúdo ao minimizar — componentes com polling
               (usePolled) param de rodar; o custo é perder estado local
               interno, que hoje mora no Redux mesmo*/}
            {!minimized && <div className={styles.content}>{children}</div>}
        </div>
    );
}
