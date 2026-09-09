import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), plugins: [react()],
  build: { target: "esnext", outDir: "/private/tmp/sauce-playback-harness-dist", emptyOutDir: true } });
