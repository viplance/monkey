import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.config.ts";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    // The side panel HTML is the only HTML entry; CRXJS picks up the rest
    // (background, content scripts) from the manifest. NOTE: Vite 8 prints a
    // harmless "Both rollupOptions and rolldownOptions were specified by
    // crx:content-scripts" warning — that comes from CRXJS's own plugin, not
    // this config, and does not affect the build.
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
      },
    },
  },
  // CRXJS needs a stable HMR port during `dev`.
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
