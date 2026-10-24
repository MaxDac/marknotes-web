import { readFile, writeFile } from "node:fs/promises";
import { publicConfig } from "./public-config.mjs";

const { version } = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url)),
);
await writeFile(
  new URL("./dist/config.json", import.meta.url),
  JSON.stringify(publicConfig(process.env)),
);
await writeFile(
  new URL("./dist/health.json", import.meta.url),
  JSON.stringify({
    status: "ok",
    version: process.env.APP_VERSION?.trim() || version,
    revision: process.env.GIT_SHA?.trim() || "unknown",
  }),
);
