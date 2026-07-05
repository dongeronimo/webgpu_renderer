//Monta a raiz React no overlay UMA vez — a UI vive acima dos mundos,
//igual ao main. Devolve um setter: apontar a UI pra outro mundo é chamar
//o setter com o mundo novo. O root.render() de novo NÃO remonta a árvore,
//o React reconcilia — estado da UI (drag, minimizado) sobrevive à troca,
//só a prop world muda e desce.
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { store } from "../redux/store";
import type { World } from "../world";
import { App } from "./App";

export function mountUi(container: HTMLElement): (world: World) => void {
    const root = createRoot(container);
    return (world: World) => {
        root.render(
            <Provider store={store}>
                <App world={world} />
            </Provider>,
        );
    };
}
