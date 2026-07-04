//Monta a raiz React no overlay. Quem chama é o main, DEPOIS de criar o
//mundo — a UI recebe a instância de World por prop, então trocar de
//"fase" é remontar a UI apontando pro mundo novo.
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { store } from "../redux/store";
import type { World } from "../world";
import { App } from "./App";

export function mountUi(container: HTMLElement, world: World): void {
    createRoot(container).render(
        <Provider store={store}>
            <App world={world} />
        </Provider>,
    );
}
