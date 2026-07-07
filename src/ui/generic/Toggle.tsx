//Toggle genérico da lib: um interruptor liga/desliga. Por baixo é um
//<input type="checkbox" role="switch"> nativo — teclado (espaço), foco e
//aria de switch de graça — com a aparência centralizada no
//Toggle.module.css. Irmão booleano do Slider.
//Componente CONTROLADO: quem usa é dono do estado (state/redux) e recebe
//onChange com o booleano já pronto.
import type { InputHTMLAttributes } from "react";
import styles from "./Toggle.module.css";

//Omit dos campos que a gente re-tipa: checked vira boolean obrigatório
//(no input nativo é opcional) e onChange entrega o booleano pronto em vez
//do evento.
export type ToggleProps = Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "onChange"
> & {
    checked: boolean;
    onChange: (checked: boolean) => void;
};

export function Toggle({ checked, onChange, className, ...rest }: ToggleProps) {
    const classes = [styles.toggle, className].filter(Boolean).join(" ");
    return (
        <input
            type="checkbox"
            //role=switch: leitor de tela anuncia "ligado/desligado" em vez
            //de "marcado", que é o certo pra um liga/desliga
            role="switch"
            className={classes}
            checked={checked}
            //currentTarget.checked já vem booleano do browser — nada de
            //derivar do value na mão
            onChange={(e) => onChange(e.currentTarget.checked)}
            {...rest}
        />
    );
}
