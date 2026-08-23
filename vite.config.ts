import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    sourcemap: true
  }
});