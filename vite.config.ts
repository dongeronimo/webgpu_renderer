import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

//O plugin dá fast refresh nos .tsx (editar UI não derruba o estado do
//renderer) e garante o JSX automatic runtime.
export default defineConfig({
    plugins: [react()],
    //Porta vem da env var PORT (ex.: `$env:PORT=4000; npm run dev` no PowerShell).
    //Sem PORT cai no default 5173. Linha idêntica em todos os branches p/ não conflitar em merge.
    server: {
        port: Number(process.env.PORT) || 5173,
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
