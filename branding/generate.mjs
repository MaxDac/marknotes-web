// Regenerates every MarkNotes icon asset from the master SVGs in this folder.
// Usage: cd branding && npm install --no-package-lock && npm run generate
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "priv", "static");
const icon = readFileSync(join(here, "marknotes-icon.svg"), "utf8");
// iOS applies its own rounded mask, so the touch icon is a full-bleed square.
const square = icon.replace(' rx="224"', "");

const png = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

/** ICO container holding PNG-compressed images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

copyFileSync(join(here, "marknotes-icon.svg"), join(out, "favicon.svg"));
copyFileSync(
  join(here, "marknotes-mark.svg"),
  join(out, "images", "marknotes-mark.svg"),
);
writeFileSync(
  join(out, "favicon.ico"),
  ico([16, 32, 48].map((size) => ({ size, data: png(icon, size) }))),
);
writeFileSync(join(out, "apple-touch-icon.png"), png(square, 180));
writeFileSync(join(out, "icon-192.png"), png(icon, 192));
writeFileSync(join(out, "icon-512.png"), png(icon, 512));
writeFileSync(
  join(out, "site.webmanifest"),
  JSON.stringify(
    {
      name: "MarkNotes",
      short_name: "MarkNotes",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#1E5EB4",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Icons written to ${out}`);
