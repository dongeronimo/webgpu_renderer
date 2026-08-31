//Catálogo de exames: o que o make_volumes_index.py escreve em
//public/volumes/index.json varrendo os metadata.json de cada volume
//exportado. É a fonte da lista do seletor de exames.
//
//O `path` de cada entrada é EXATAMENTE o baseUrl que loadVolumeTexture()
//recebe ("/volumes/abd_1mm"), então a UI escolhe e repassa — ninguém monta
//caminho no meio do caminho. Trocar o nome de um diretório de volume e
//regerar o índice é a única coisa necessária pra um exame mudar de lugar.

/** Uma entrada do public/volumes/index.json. */
export interface VolumeCatalogEntry {
    /** Rótulo legível: "ANGIO-RM VENOSA CRANIO — ARTERIAL TOF SJ". */
    name: string;
    /** baseUrl do volume, pronto pro loadVolumeTexture: "/volumes/abd_1mm". */
    path: string;
}

const CATALOG_URL = "/volumes/index.json";

/**
 * Busca o catálogo de exames. Lança com mensagem legível — quem chama (o
 * modal de seleção) mostra o erro na tela, porque sem catálogo não há o que
 * escolher e o mundo não tem como prosseguir.
 */
export async function loadVolumeCatalog(): Promise<VolumeCatalogEntry[]> {
    const response = await fetch(CATALOG_URL);
    if (!response.ok) {
        throw new Error(`Falha ao buscar ${CATALOG_URL}: HTTP ${response.status}`);
    }
    //Mesma pegadinha do volumeLoader/textureLoader: o dev server do Vite
    //responde 200 + index.html pra caminho inexistente, então o status não
    //denuncia o arquivo faltando — o content-type sim.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
        throw new Error(
            `${CATALOG_URL} não existe (o Vite devolveu o index.html no lugar). ` +
            `Rode: python make_volumes_index.py`,
        );
    }

    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
        throw new Error(`${CATALOG_URL} não é uma lista de exames.`);
    }
    //Validação item a item, e não um cast: o índice é gerado por um script
    //Python fora do type-check do TS, então uma entrada capenga só apareceria
    //aqui — melhor falhar com o nome do campo do que com um undefined lá na
    //frente, no meio da carga do volume.
    const entries: VolumeCatalogEntry[] = parsed.map((item, i) => {
        const name = (item as VolumeCatalogEntry)?.name;
        const path = (item as VolumeCatalogEntry)?.path;
        if (typeof name !== "string" || typeof path !== "string") {
            throw new Error(`${CATALOG_URL}: entrada ${i} sem "name"/"path" string.`);
        }
        return { name, path };
    });

    if (entries.length === 0) {
        throw new Error(
            `${CATALOG_URL} está vazio — nenhum exame em public/volumes/.`,
        );
    }
    return entries;
}
