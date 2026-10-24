import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { publicConfig } from "../public-config.mjs";

const origin = "http://localhost:4107";
let server;
before(async () => {
  server = spawn(
    "caddy",
    ["run", "--config", "../Caddyfile", "--adapter", "caddyfile"],
    {
      env: { ...process.env, PORT: "4107", SITE_ROOT: "dist" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let error = "";
  server.stderr.on("data", (chunk) => {
    error += chunk;
  });
  server.on("error", (cause) => {
    error += String(cause);
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      /* Wait for the test server to bind. */
    }
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Caddy did not start: ${error}`);
});
after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
});

test("serves a static browser-owned shell with no cookie or socket bootstrap", async () => {
  const response = await fetch(origin);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="marknotes"/);
  assert.doesNotMatch(html, /csrf|phx-hook|phx-update|SECRET_KEY_BASE/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)];
  assert.ok(scripts.length);
  const asset = await fetch(origin + scripts[0][1]);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
});
test("preserves CSP and privacy headers on app, callbacks and errors", async () => {
  for (const path of [
    "/",
    "/security",
    "/oauth/dropbox?code=private-code",
    "/oauth/onedrive",
    "/missing",
  ]) {
    const response = await fetch(origin + path);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(csp, /worker-src 'self';/);
    assert.match(csp, /img-src 'self' data: blob:;/);
    assert.match(csp, /https:\/\/api.dropboxapi.com/);
    assert.doesNotMatch(csp, /'unsafe-eval'|wss?:|connect-src https:/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
    assert.doesNotMatch(await response.text(), /private-code/);
  }
});
test("security page is script-free and documents storage and offline limits", async () => {
  const response = await fetch(origin + "/security");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Encrypted with a passphrase/);
  assert.match(html, /Memory only/);
  assert.match(html, /Offline use and app updates/);
  assert.doesNotMatch(html, /<script/);
});
test("health and runtime public config remain uncached JSON", async () => {
  const response = await fetch(origin + "/health");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    await response.json(),
    JSON.parse(await readFile("dist/health.json")),
  );
  const config = await fetch(origin + "/config.json");
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.equal((await config.json()).schema, 1);
});
test("keeps callbacks distinct and unknown routes as genuine 404s", async () => {
  for (const provider of ["dropbox", "onedrive"]) {
    const response = await fetch(
      `${origin}/oauth/${provider}?code=test&state=test`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.redirected, false);
    assert.match(await response.text(), /Completing sign-in/);
  }
  for (const path of [
    "/oauth/unknown",
    "/assets/missing.js",
    "/live",
    "/missing",
  ])
    assert.equal((await fetch(origin + path)).status, 404, path);
});
test("serves manifest, icons, worker and worker imports", async () => {
  for (const path of [
    "/site.webmanifest",
    "/favicon.svg",
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
    "/sw.js",
  ]) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  const manifest = await (await fetch(origin + "/site.webmanifest")).json();
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
  const worker = await fetch(origin + "/sw.js");
  assert.equal(worker.headers.get("cache-control"), "no-store");
  const source = await worker.text();
  assert.doesNotMatch(source, /oauth\/(dropbox|onedrive)\.html/);
});
test("public configuration defaults, blank overrides and strings are unambiguous", () => {
  assert.equal(publicConfig({}).dropbox, "sdjefhss3elcfp3");
  assert.equal(publicConfig({ DROPBOX_APP_KEY: "  " }).dropbox, "");
  const config = publicConfig({
    DROPBOX_APP_KEY: ' key"\\\n ',
    MSAL_CLIENT_ID: " custom ",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    schema: 1,
    dropbox: 'key"\\',
    onedrive: "custom",
  });
});
