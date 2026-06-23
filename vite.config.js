import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  publicDir: "docs/ai-output",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
