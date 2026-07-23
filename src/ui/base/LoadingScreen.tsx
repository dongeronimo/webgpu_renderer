//Tela de carga: modal bloqueante da UI base. Vive no App (como o WorldSwitch) e
//sobrevive à troca de mundo, porque é da app e não de um mundo. Lê só a flag
//base.loading — o ctor do World a levanta e o 1º update() dele a baixa (ver
//world.ts), então este componente não sabe (nem precisa saber) QUAL mundo está
//carregando. Um spinner girando, SEM barra de progresso de propósito: a carga
//(fetch de assets + upload pra GPU) não tem progresso contabilizável.
//Sem onDismiss no ModalPanel: obrigatório, não dá pra fechar à mão.
import { useSelector } from "react-redux";
import type { RootState } from "../../redux/reducers";
import { ModalPanel } from "../generic/ModalPanel";
import styles from "./LoadingScreen.module.css";

export function LoadingScreen() {
    const loading = useSelector((state: RootState) => state.base.loading);
    if (!loading) {
        return null;
    }
    return (
        <ModalPanel title="Carregando" width="auto" height="auto">
            <div className={styles.body}>
                <div className={styles.spinner} />
                <span className={styles.label}>Carregando o mundo…</span>
            </div>
        </ModalPanel>
    );
}
