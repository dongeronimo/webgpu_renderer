//Tela de entrada do mundo do lasso: escolha do exame. Sem onDismiss de
//propósito — é obrigatória, não dá pra fechar sem escolher (ver
//ModalPanel.onDismiss), exatamente como a escolha de personagem do gauntlet.
//
//Quem ABRE é a ExamSelectionBehaviour do mundo (dispatch de examShowSelection
//quando não há exame carregado) e quem espera o resultado é ela também: com
//exam.selected preenchido, o mundo dispara loadExam() e só então monta textura
//3D, gradiente, material e cubo-proxy — ver raycastLassoWorld.ts.
//
//O catálogo é buscado AQUI, em state local, e não no redux: é dado remoto
//estático pra desenhar uma lista, não intenção do usuário. Ao redux vai só a
//escolha. Mesmo critério do POST /login, que mora no GauntletLoginPanel.
import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { examChosen } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { loadVolumeCatalog, type VolumeCatalogEntry } from "../../volumeCatalog";
import { ModalPanel } from "../generic/ModalPanel";
import styles from "./ExamSelectPanel.module.css";

export function ExamSelectPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const { choosing, error } = useSelector((state: RootState) => state.exam);
    const [catalog, setCatalog] = useState<VolumeCatalogEntry[] | null>(null);
    const [catalogError, setCatalogError] = useState<string | null>(null);

    //Busca uma vez por montagem do componente. Ele só monta no mundo do lasso
    //(ver WorldUi), então sair e voltar rebusca — é um json de algumas linhas,
    //e assim um exame exportado no meio da sessão aparece sem recarregar a
    //página.
    useEffect(() => {
        let cancelled = false;
        loadVolumeCatalog()
            .then((entries) => {
                if (!cancelled) setCatalog(entries);
            })
            .catch((err: Error) => {
                console.error("ExamSelectPanel: falha carregando o catálogo", err);
                if (!cancelled) setCatalogError(err.message);
            });
        //A carga é async e o componente some quando o exame é escolhido: sem
        //isto, um setState depois da desmontagem.
        return () => { cancelled = true; };
    }, []);

    if (!choosing) {
        return null;
    }

    return (
        <ModalPanel title="Escolha o exame" width="auto" height="auto">
            {/*Erro da carga do VOLUME (fase 2 do mundo), não do catálogo: o
               modal reabre com ele na tela pra escolha nova. Ver o
               EXAM_LOAD_FAILED no reducer.*/}
            {error && <div className={styles.error}>{error}</div>}

            {catalogError !== null ? (
                <div className={styles.error}>{catalogError}</div>
            ) : catalog === null ? (
                <div className={styles.message}>Carregando a lista de exames…</div>
            ) : (
                <div className={styles.list}>
                    {catalog.map((entry) => (
                        <button
                            key={entry.path}
                            type="button"
                            className={styles.item}
                            onClick={() => dispatch(examChosen(entry))}
                        >
                            <span className={styles.name}>{entry.name}</span>
                            <span className={styles.path}>{entry.path}</span>
                        </button>
                    ))}
                </div>
            )}
        </ModalPanel>
    );
}
