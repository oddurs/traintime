/**
 * The app icons, from the same drawing as the mark in the interface.
 *
 * They used to be three hand-made PNGs, which is how an icon and a logo drift apart: nothing
 * connects them, so nothing notices. These are rasterised from `brandIconSvg`, which is the same
 * bullet path, font and baseline the map draws a train with.
 *
 * Run with `npm run build:icons` when the mark changes. Not part of the build: it needs Helvetica,
 * which a Linux build image does not have, and the results are committed.
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { brandIconSvg, brandMarkSvg } from "../src/lib/brand";

const OUT = join(import.meta.dirname, "..", "public");
/** The map's own ground, the bullet, and the character on it. */
const TILE = "#0a0a0a";
const GROUND = "#ffffff";
const INK = "#0a0a0a";

const png = async (svg: string, px: number, name: string) => {
  await sharp(Buffer.from(svg), { density: 384 }).resize(px, px).png({ compressionLevel: 9 }).toFile(join(OUT, name));
  console.log(`  ${name} — ${px}×${px}`);
};

async function main() {
  // One drawing at four sizes. The bullet already sits inside the safe zone, so the maskable and
  // Apple variants are the same image rather than a second design that has to be kept in step.
  for (const [px, name] of [[192, "icon-192.png"], [512, "icon-512.png"], [512, "icon-maskable.png"], [180, "apple-icon.png"]] as const) {
    await png(brandIconSvg(TILE, GROUND, INK, px), px, name);
  }
  // The mark itself, for anything that can take a vector.
  writeFileSync(join(OUT, "mark.svg"), brandMarkSvg(GROUND, INK));
  console.log("  mark.svg");
}

void main();
