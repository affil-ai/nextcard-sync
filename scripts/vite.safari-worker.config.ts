import { defineConfig } from "vite";
import { resolve } from "node:path";
import { getExtensionDefines } from "../extension-build-config";

export default defineConfig({
  publicDir: false,
  define: getExtensionDefines("safari"),
  build: {
    outDir: resolve(import.meta.dirname, "../dist-safari"),
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "../src/background/service-worker.ts"),
      formats: ["iife"],
      name: "NextcardSafariBackground",
      fileName: () => "safari-service-worker.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
