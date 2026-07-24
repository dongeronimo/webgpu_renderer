//Segregação VR × Gauntlet por SUBDOMÍNIO, decidida em runtime pelo hostname.
//É UM bundle só, servido em dois subdomínios (cada um com sua distribuição
//CloudFront) — este módulo esconde na UI os worlds que não pertencem ao
//domínio atual, e escolhe o world de boot. localhost (e qualquer host
//desconhecido, tipo a URL crua do *.cloudfront.net) mostra TUDO, pra dev.
//
//1ª SEGREGAÇÃO: só filtra a UI. O código dos worlds escondidos ainda vai no
//bundle — split de verdade (por domínio) é um passo posterior.
import { WorldName } from "./redux/actions";

type AppId = "vr" | "gauntlet";

//A que app cada world pertence. Record<WorldName,...> de propósito: world novo
//quebra em compile time até ser classificado aqui. Mover um world entre apps é
//só trocar o valor.
const worldApp: Record<WorldName, AppId> = {
    solarSystem: "gauntlet",
    textureStackVolumeRenderSynthetic: "vr",
    textureStackVolumeRenderCT: "vr",
    StarshipDemo: "gauntlet",
    raycast: "vr",
    raycastESS: "vr",
    gameVolume: "vr",
    train: "gauntlet",
    SkinningDemo: "gauntlet",
    gauntlet: "gauntlet",
};

//World que abre no boot de cada app. localhost/desconhecido mantém o world de
//trabalho atual (SkinningDemo).
const defaultWorldByApp: Record<AppId, WorldName> = {
    vr: "textureStackVolumeRenderSynthetic",
    gauntlet: "gauntlet",
};

//null = mostra tudo (localhost, 127.0.0.1, *.cloudfront.net cru...).
function currentApp(): AppId | null {
    switch (location.hostname) {
        case "gauntlet.dongeronimo.net": return "gauntlet";
        case "vr.dongeronimo.net":       return "vr";
        default:                         return null;
    }
}

/** No domínio de um app, só os worlds dele aparecem; em localhost, todos. */
export function isWorldVisible(world: WorldName): boolean {
    const app = currentApp();
    return app === null || worldApp[world] === app;
}

/** World inicial conforme o domínio — usado pelo reducer e pelo boot do main. */
export function defaultWorld(): WorldName {
    const app = currentApp();
    return app === null ? "SkinningDemo" : defaultWorldByApp[app];
}

/** Base do backend do Gauntlet (login/api/ws). Em prod
 *  (gauntlet.dongeronimo.net) é o `api.dongeronimo.net` DIRETO — fora do
 *  CloudFront (~30ms vs ~250ms; o CloudFront roteava pra um edge longe). Em
 *  dev/localhost e na URL crua do *.cloudfront.net, "" = relativo (proxy do
 *  Vite / behaviors do CloudFront). Ver etapa 1 em src/instructions/multiplayer.md. */
export function backendBase(): string {
    return location.hostname === "gauntlet.dongeronimo.net"
        ? "https://api.dongeronimo.net"
        : "";
}
