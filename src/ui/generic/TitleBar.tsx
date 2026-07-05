//Barra de título genérica pra cabeçalho de painel do overlay. Mesma
//filosofia do Button: aparência 100% no TitleBar.module.css, consumidor
//só escolhe os slots.
//O texto do título vai em children (e não numa prop "title") porque
//HTMLAttributes já tem title?: string — o tooltip nativo — e a colisão
//de tipos estreitaria o título pra string.
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./TitleBar.module.css";

export type TitleBarProps = HTMLAttributes<HTMLDivElement> & {
    icon?: ReactNode;
    //slot da direita — tipicamente <Button variant="ghost" size="sm"/>
    //de fechar/recolher; a TitleBar não impõe quais ações existem
    actions?: ReactNode;
    children: ReactNode;
};

export function TitleBar({ icon, actions, children, className, ...rest }: TitleBarProps) {
    const classes = [styles.titleBar, className].filter(Boolean).join(" ");
    return (
        <div className={classes} {...rest}>
            {icon && (
                <span className={styles.icon} aria-hidden="true">{icon}</span>
            )}
            <span className={styles.title}>{children}</span>
            {actions && <span className={styles.actions}>{actions}</span>}
        </div>
    );
}
