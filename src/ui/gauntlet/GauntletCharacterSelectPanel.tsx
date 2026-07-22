//Modal pós-login: escolha de personagem. Sem onDismiss de propósito — é
//obrigatório, não dá pra fechar sem escolher (ver ModalPanel.onDismiss).
//GauntletNetworkBehaviour.update() é quem abre esta tela (dispatch de
//gauntletShowCharacterSelectionScreen assim que loggedIn vira true) e quem
//espera o resultado (gauntlet.character) pra prosseguir com o rito de
//conexão — ver GauntletNetwork.ts.
import { useDispatch, useSelector } from "react-redux";
import { gauntletCharacterChosen } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { ModalPanel } from "../generic/ModalPanel";
import styles from "./GauntletCharacterSelectPanel.module.css";

//Flavor text estático (não busca stats ao vivo) — só pra escolha ter algum
//contexto. Reflete PlayerControllerSettingsPersistence.defaults() no
//server: um espectro de arquétipos (robusto→ágil→rápido/frágil), não só
//números aleatórios. playable:false = sem linha em PlayerControllerSettings
//ainda (sem prefab pronto) — card fica grayed-out, sem onClick; o server
//rejeitaria ("badCharacter") mesmo que alguém forçasse a escolha por fora.
const CHARACTERS = [
    { character: "Dmitry", blurb: "Shock trooper soviético. Robusto, mais lento, corpo maior.", playable: true },
    { character: "Nat", blurb: "Oficial científica soviética. Ágil, rápida e vira rápido.", playable: true },
    { character: "Abigail", blurb: "Espiã do Mossad. A mais rápida e ágil, porém a mais frágil.", playable: true },
    { character: "Ramirez", blurb: "Soldado estilo Rambo. O mais robusto, arranca rápido.", playable: true },
    { character: "Yukio", blurb: "Yakuza. Em preparação.", playable: false },
] as const;

export function GauntletCharacterSelectPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const choosingCharacter = useSelector((state: RootState) => state.gauntlet.choosingCharacter);

    if (!choosingCharacter) {
        return null;
    }

    return (
        <ModalPanel title="Escolha seu personagem" width="auto" height="auto">
            <div className={styles.cards}>
                {CHARACTERS.map(({ character, blurb, playable }) => (
                    <button
                        key={character}
                        type="button"
                        className={styles.card}
                        disabled={!playable}
                        onClick={() => dispatch(gauntletCharacterChosen(character))}
                    >
                        <span className={styles.name}>{character}</span>
                        <span className={styles.blurb}>{blurb}</span>
                    </button>
                ))}
            </div>
        </ModalPanel>
    );
}
