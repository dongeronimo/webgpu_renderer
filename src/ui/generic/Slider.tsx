//Slider genérico da lib: um knob que vai do mínimo ao máximo. Por baixo é
//um <input type="range"> nativo — teclado (setas/home/end), aria e touch
//de graça — com a aparência centralizada no Slider.module.css.
//Componente CONTROLADO: quem usa é dono do valor (state/redux) e recebe
//onChange a cada movimento do knob, contínuo durante o arrasto.
import type { InputHTMLAttributes } from "react";
import styles from "./Slider.module.css";

//Omit dos campos que a gente re-tipa: min/max/value viram number
//obrigatórios (no input nativo são string|number opcionais) e onChange
//entrega o número pronto em vez do evento.
export type SliderProps = Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "min" | "max" | "value" | "step" | "onChange"
> & {
    min: number;
    max: number;
    value: number;
    //granularidade do knob; "any" = contínuo (default 1, igual ao nativo)
    step?: number | "any";
    onChange: (value: number) => void;
};

export function Slider({ min, max, value, step = 1, onChange, className, ...rest }: SliderProps) {
    const classes = [styles.slider, className].filter(Boolean).join(" ");
    return (
        <input
            type="range"
            className={classes}
            min={min}
            max={max}
            step={step}
            value={value}
            //valueAsNumber: o value de input é sempre string, o parse é do
            //browser — nada de Number() na mão
            onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
            {...rest}
        />
    );
}
