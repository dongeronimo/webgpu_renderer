//Botão genérico da lib de componentes. Todo CSS dele vive no
//Button.module.css — consumidor escolhe variant/size/icon e não passa
//style de aparência (senão a centralização morre no primeiro uso).
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type BaseProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md" | "lg";
    iconPosition?: "left" | "right";
};

//Só-ícone: sem children, e aí o aria-label vira obrigatório — sem ele o
//botão não tem nome acessível nenhum.
type IconOnlyProps = BaseProps & {
    icon: ReactNode;
    children?: undefined;
    "aria-label": string;
};

//Com texto: children obrigatório, ícone opcional dos dois lados.
type WithTextProps = BaseProps & {
    icon?: ReactNode;
    children: ReactNode;
};

export type ButtonProps = IconOnlyProps | WithTextProps;

export function Button({
    variant = "primary",
    size = "md",
    icon,
    iconPosition = "left",
    children,
    className,
    //default "button" porque o default do HTML é "submit" — dentro de um
    //<form> isso dispararia submit sem ninguém pedir
    type = "button",
    ...rest
}: ButtonProps) {
    //className do consumidor entra por último: serve pra layout (margin,
    //grid-area), não pra aparência
    const classes = [styles.button, styles[variant], styles[size], className]
        .filter(Boolean)
        .join(" ");
    return (
        <button type={type} className={classes} {...rest}>
            {icon && iconPosition === "left" && (
                <span className={styles.icon} aria-hidden="true">{icon}</span>
            )}
            {children}
            {icon && iconPosition === "right" && (
                <span className={styles.icon} aria-hidden="true">{icon}</span>
            )}
        </button>
    );
}
