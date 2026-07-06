//ProgressBar genérica da lib. Diferente do Slider, aqui NÃO uso o elemento
//nativo: <progress> não tem interação que justifique (nada de teclado) e o
//styling dele é inconsistente entre browsers — duas divs + role/aria dão o
//mesmo resultado acessível com CSS são.
//Dois modos:
//  - determinado: value (0..max) preenche proporcionalmente;
//  - indeterminado: OMITA value — a barra anima de um lado pro outro.
//    É o modo pra "carregando mundo/volume" quando não há progresso real.
import type { HTMLAttributes } from "react";
import styles from "./ProgressBar.module.css";

export type ProgressBarProps = HTMLAttributes<HTMLDivElement> & {
    //0..max; ausente = indeterminado
    value?: number;
    max?: number;
};

export function ProgressBar({ value, max = 100, className, ...rest }: ProgressBarProps) {
    const indeterminate = value === undefined;
    //clamp: value fora de 0..max (ou max inválido) não pode estourar o track
    const ratio = !indeterminate && max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
    const classes = [styles.track, className].filter(Boolean).join(" ");
    return (
        <div
            className={classes}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={max}
            //sem aria-valuenow = indeterminado, é assim que a spec sinaliza
            aria-valuenow={indeterminate ? undefined : value}
            {...rest}
        >
            <div
                className={indeterminate ? styles.fillIndeterminate : styles.fill}
                style={indeterminate ? undefined : { width: `${ratio * 100}%` }}
            />
        </div>
    );
}
