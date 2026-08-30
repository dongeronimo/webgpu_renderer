//Grupo de ferramentas MUTUAMENTE EXCLUSIVAS — exatamente uma acesa, sempre.
//
//Por baixo são <input type="radio"> nativos de verdade, com o mesmo name, e
//não <button> com aria-checked: assim vêm de graça a navegação por setas
//dentro do grupo, o foco rovinante (Tab entra no grupo uma vez só, não em
//cada item), e o leitor de tela anunciando "botão de opção, 2 de 3". É o
//mesmo negócio que o Toggle faz com o checkbox — o input fica invisível (mas
//FOCÁVEL, nada de display:none) e quem pinta é o <label> em volta.
//
//Componente CONTROLADO: quem usa é dono do estado (aqui, o redux) e recebe o
//value já pronto no onChange. Genérico no T pra o value ser a union do
//consumidor (ToolName) e não string solta.
import type { ReactNode } from "react";
import styles from "./ToolRadioGroup.module.css";

export type ToolRadioItem<T extends string> = {
    value: T;
    label: string;
    icon?: ReactNode;
    /** Tooltip do item — o "o que essa ferramenta faz" e o atalho, se tiver. */
    hint?: string;
};

export type ToolRadioGroupProps<T extends string> = {
    /** name do grupo de radios; tem que ser único na página. */
    name: string;
    /** Nome acessível do grupo (o <div role=radiogroup> não tem <legend>). */
    label: string;
    items: readonly ToolRadioItem<T>[];
    value: T;
    onChange: (value: T) => void;
};

export function ToolRadioGroup<T extends string>({
    name,
    label,
    items,
    value,
    onChange,
}: ToolRadioGroupProps<T>) {
    return (
        <div className={styles.group} role="radiogroup" aria-label={label}>
            {items.map((item) => (
                //O <label> em volta do input é o que faz a caixa inteira ser
                //área de clique — sem htmlFor/id pra sincronizar.
                <label key={item.value} className={styles.item} title={item.hint}>
                    <input
                        type="radio"
                        className={styles.input}
                        name={name}
                        value={item.value}
                        checked={value === item.value}
                        onChange={() => onChange(item.value)}
                    />
                    {item.icon && (
                        <span className={styles.icon} aria-hidden="true">{item.icon}</span>
                    )}
                    <span className={styles.label}>{item.label}</span>
                </label>
            ))}
        </div>
    );
}
