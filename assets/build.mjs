import { build } from "esbuild";
await build({
  entryPoints: { app: "js/app.ts", callback: "js/callback.ts" },
  outdir: "../priv/static/assets",
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "linked",
});
