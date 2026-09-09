// Bolt UXP packaging, reduced to the React/Premiere target; no webview or hybrid addon.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { uxp } from "vite-uxp-plugin";
import { config } from "./uxp.config";

export default defineConfig({
  base: "./",
  plugins: [uxp(config, process.env.MODE ?? "build"), react()],
  build: {
    target: "es2020",
    sourcemap: false,
    minify: false,
    rollupOptions: {
      external: ["premierepro", "uxp"],
      output: { format: "iife" },
    },
  },
  publicDir: "public",
});
