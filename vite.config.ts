import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
//O diretório dos exames convertidos. Fica dentro de public/ pra o dev server
//servi-lo de graça em /volumes, mas é TRATADO À PARTE no build e no deploy.
const VOLUMES_DIRNAME = "volumes";

/**
 * Copia public/ pro dist, PULANDO os volumes.
 *
 * Os exames são centenas de MB (787 MB em 3 exames, e cresce a cada um) e são
 * IMUTÁVEIS: uma vez exportado, um exame nunca muda. Copiá-los pro dist a cada
 * build custava ~6,5s dos 11,7s do build limpo e duplicava tudo em disco, pra
 * produzir bytes idênticos aos de public/volumes.
 *
 * Quem os leva pra produção é o deploy/deploy.py, que sincroniza
 * public/volumes direto pro S3 (ver `deploy.py volumes`) — e o sync do dist
 * exclui o prefixo volumes/ pra o --delete dele não apagar os exames de lá.
 *
 * Pareado com build.copyPublicDir: false, que desliga a cópia nativa do Vite.
 * O DEV SERVER não é afetado: copyPublicDir só vale no build, então
 * `npm run dev` continua servindo /volumes de public/ como sempre.
 */
function copyPublicExceptVolumes(): Plugin {
    return {
        name: "copy-public-except-volumes",
        apply: "build",
        closeBundle() {
            const outDir = path.join(ROOT, "dist");
            if (!fs.existsSync(PUBLIC_DIR)) return;
            for (const entry of fs.readdirSync(PUBLIC_DIR)) {
                if (entry === VOLUMES_DIRNAME) continue;
                fs.cpSync(path.join(PUBLIC_DIR, entry), path.join(outDir, entry),
                    { recursive: true });
            }
        },
    };
}

/**
 * `npm run preview` serve o dist, que agora não tem os volumes — sem isto o
 * seletor de exames tomaria 404 e o preview deixaria de ser um ensaio honesto
 * de produção. Serve /volumes direto de public/volumes, que é onde eles estão.
 */
function servePreviewVolumes(): Plugin {
    return {
        name: "serve-preview-volumes",
        apply: "serve",
        configurePreviewServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0];
                if (!url.startsWith(`/${VOLUMES_DIRNAME}/`)) return next();
                //decodeURIComponent + normalize e depois confere que o
                //resultado continua DENTRO de public/volumes: sem isso um
                //"/volumes/../../.." leria qualquer arquivo da máquina.
                const rel = path.normalize(decodeURIComponent(
                    url.slice(`/${VOLUMES_DIRNAME}/`.length)));
                const base = path.join(PUBLIC_DIR, VOLUMES_DIRNAME);
                const file = path.join(base, rel);
                if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return next();
                res.setHeader("Content-Type", file.endsWith(".json")
                    ? "application/json" : "application/octet-stream");
                fs.createReadStream(file).pipe(res);
            });
        },
    };
}

//O plugin do react dá fast refresh nos .tsx (editar UI não derruba o estado do
//renderer) e garante o JSX automatic runtime.
export default defineConfig({
    plugins: [react(), copyPublicExceptVolumes(), servePreviewVolumes()],
    build: {
        //ver copyPublicExceptVolumes(): a cópia de public/ passa a ser nossa,
        //pra poder pular os volumes. Só afeta o build; o dev server continua
        //servindo public/ inteiro.
        copyPublicDir: false,
    },
    //Porta vem da env var PORT (ex.: `$env:PORT=4000; npm run dev` no PowerShell).
    //Sem PORT cai no default 5173. Linha idêntica em todos os branches p/ não conflitar em merge.
    server: {
        port: Number(process.env.PORT) || 5174, //mudei hardcoded pra 5174 pra poder testar dois branches separados ao mesmo tempo
         proxy: {
      "/ws":     { target: "ws://localhost:8080", ws: true },
      "/login":  { target: "http://localhost:8080", changeOrigin: false },
      "/logout": { target: "http://localhost:8080", changeOrigin: false },
      //Faltava — GET /api/player-controller-settings/{character} caía no
      //fallback de SPA do próprio Vite (serve index.html pra rota
      //desconhecida), por isso o fetch recebia HTML em vez de JSON
      //("Unexpected token '<'"). Só afeta as constantes de predição LOCAL
      //do client (moveSpeedForward etc. em GauntletNetworkBehaviour) — o
      //server sempre usou a própria cópia, autoritativa, então isto nunca
      //foi a causa de bug de pose/animação, só de a predição local do
      //client divergir um pouco do server até o próximo snap corrigir.
      "/api":    { target: "http://localhost:8080", changeOrigin: false },
        }
    },
});
