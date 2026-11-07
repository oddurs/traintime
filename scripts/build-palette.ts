/**
 * Writes the colour primitives into src/app/tokens.css, and the canvas's copy of the palette into
 * src/lib/palette.ts, from the ramps in src/lib/ramps.ts.
 *
 * Usage: npx tsx scripts/build-palette.ts [--check]
 *   --check  write nothing; exit 1 if either file is out of date (tests/palette.test.ts runs this)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPalette, renderRampBlock } from "../src/lib/ramps";

const TOKENS = join(process.cwd(), "src/app/tokens.css");
const PALETTE = join(process.cwd(), "src/lib/palette.ts");
const check = process.argv.includes("--check");

const tokens = readFileSync(TOKENS, "utf8");
const palette = readFileSync(PALETTE, "utf8");
const nextTokens = renderRampBlock(tokens);
const nextPalette = renderPalette(palette, nextTokens);

const stale = [[TOKENS, tokens, nextTokens], [PALETTE, palette, nextPalette]].filter(([, a, b]) => a !== b);
if (check) {
  for (const [file] of stale) console.error(`${file} is out of date: run npm run build:palette`);
  process.exit(stale.length ? 1 : 0);
}
for (const [file, , next] of stale) writeFileSync(file, next);
console.log(stale.length ? `wrote ${stale.map(([f]) => f.split("/").slice(-1)[0]).join(", ")}` : "palette up to date");
