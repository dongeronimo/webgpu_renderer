import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

//O plugin dá fast refresh nos .tsx (editar UI não derruba o estado do
//renderer) e garante o JSX automatic runtime.
export default defineConfig({
    plugins: [react()],
});
