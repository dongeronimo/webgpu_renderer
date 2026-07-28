import type { MapCellDto } from "./dto/ServerMessage";

/**
 * O mapa estático do client: as células RICAS do mapSync (espelho do GameMap
 * do server) num objeto que sabe responder por coordenada, em vez de todo
 * mundo indexar array cru na mão.
 *
 * Duas leituras diferentes moram aqui e não devem se misturar:
 *  - CATEGORIA: quem colide. Predição local (MineAvatarBehaviour, via
 *    GauntletNetwork.isFreeAtCells) usa SÓ isto, exatamente como o server
 *    (GameMap.isWalkable) — divergir aqui = pawn atravessando parede na tela e
 *    tomando rewind no snap seguinte.
 *  - TIPO + EXTRAS: quem decora. Qual prefab instanciar, e o que gerar
 *    localmente a partir do que o server compactou (ex.: a seed de grama:
 *    UMA string vira N tufos aqui, sem tráfego por tufo).
 *
 * Fora do grid conta como parede sólida em toda pergunta — a borda do mapa
 * gerado já é maciça, isto é o cinto de segurança pra ninguém precisar tratar
 * "andei pra fora do mundo".
 */
export class GauntletMap {
    readonly w: number;
    readonly h: number;
    //row-major: cells[z*w + x], w*h entradas
    private readonly cells: MapCellDto[];

    constructor(w: number, h: number, cells: MapCellDto[]) {
        //Falha AQUI, legível, em vez de sair espalhando undefined pelo mundo:
        //índice-como-posição só vale se a lista tiver o grid inteiro.
        if (cells.length !== w * h) {
            throw new Error(`GauntletMap: mapSync ${w}x${h} pede ${w * h} células, veio ${cells.length}`);
        }
        this.w = w;
        this.h = h;
        this.cells = cells;
    }

    /** undefined fora do grid. */
    at(x: number, z: number): MapCellDto | undefined {
        if (x < 0 || x >= this.w || z < 0 || z >= this.h) return undefined;
        return this.cells[z * this.w + x];
    }

    /** Fora do grid = false (colide). Mesma regra do GameMap.isWalkable. */
    isPassable(x: number, z: number): boolean {
        return this.at(x, z)?.category === "passable";
    }

    /** undefined se a célula não existe ou não tem esse extra. */
    extra(x: number, z: number, key: string): string | undefined {
        return this.at(x, z)?.extras?.[key];
    }

    /** Varredura row-major com a posição já resolvida — a forma normal de
     *  quem gera conteúdo a partir do mapa (chão, paredes, grama) percorrer. */
    forEachCell(fn: (cell: MapCellDto, x: number, z: number) => void): void {
        for (let z = 0; z < this.h; z++) {
            for (let x = 0; x < this.w; x++) {
                fn(this.cells[z * this.w + x], x, z);
            }
        }
    }

    /** Vista de DEBUG estilo roguelike (`console.log(map.toRows().join("\n"))`).
     *  O fio não é mais texto; a leitura a olho continua existindo aqui e no
     *  GameMap.toRows() do server, com os MESMOS símbolos. */
    toRows(): string[] {
        const rows: string[] = [];
        for (let z = 0; z < this.h; z++) {
            let row = "";
            for (let x = 0; x < this.w; x++) {
                const cell = this.cells[z * this.w + x];
                if (cell.category !== "passable") row += "#";
                else if (cell.extras?.[MapExtras.PLAYER_SPAWN] !== undefined) row += "S";
                else if (cell.extras?.[MapExtras.EXIT] !== undefined) row += "E";
                else row += ".";
            }
            rows.push(row);
        }
        return rows;
    }
}

/** Chaves de extras que o server escreve — espelho dos GameMap.EXTRA_* do
 *  Java. Constante em vez de string solta pra o dia em que uma delas mudar de
 *  nome não virar caça ao literal. */
export const MapExtras = {
    /** Valor = índice do spawn ("0".."3"). Quem nasce onde é decisão do server
     *  (ele escolhe a célula no join); o client só usa isto pra debug/UI. */
    PLAYER_SPAWN: "playerSpawn",
    /** Valor "true" — a saída, onde o boss vai morar. */
    EXIT: "exit",
    /** Valor = u32 em 8 hex ("1f8f31c2"): 8 bits altos de DENSIDADE (0..255,
     *  quantos tufos plantar) + 24 bits de SEED (de onde saem posição, rotação
     *  e escala de cada tufo). Ausente = célula sem grama. */
    GRASS_SEED: "grassSeed",
} as const;
