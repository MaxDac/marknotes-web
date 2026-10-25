import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { publicConfig } from "./public-config.mjs";

export default defineConfig({
  appType: "mpa",
  publicDir: "../priv/static",
  build: {
    license: { fileName: "licenses.txt" },
    target: "es2022",
    rollupOptions: {
      input: {
        app: "index.html",
        security: "security.html",
        dropbox: "oauth/dropbox.html",
        onedrive: "oauth/onedrive.html",
      },
    },
  },
  plugins: [
    {
      name: "public-config",
      configureServer(server) {
        server.middlewares.use("/config.json", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(publicConfig(process.env)));
        });
      },
    },
    VitePWA({
      strategies: "injectManifest",
      srcDir: "js",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: [
          "index.html",
          "security.html",
          "assets/*.{js,mjs,css,wasm}",
          "*.{ico,png,svg,webmanifest}",
          "images/*.svg",
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});
