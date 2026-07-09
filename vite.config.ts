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
    },
});
