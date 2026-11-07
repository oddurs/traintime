/** The colour system: one set of ramps, written out exactly, and grounded in the MTA's hues. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUES, STEPS, oklch, renderPalette, renderRampBlock, toOklch } from "../src/lib/ramps";
import { TRUNKS } from "../src/lib/trunks";
import { PALETTE } from "../src/lib/palette";

const tokens = readFileSync(join(process.cwd(), "src/app/tokens.css"), "utf8");
const palette = readFileSync(join(process.cwd(), "src/lib/palette.ts"), "utf8");

test("the generated ramps and the canvas's palette are up to date", () => {
  assert.equal(renderRampBlock(tokens), tokens, "tokens.css is stale: run npm run build:palette");
  assert.equal(renderPalette(palette, tokens), palette, "palette.ts is stale: run npm run build:palette");
});

test("every hue is the MTA's, measured from the colour it prints", () => {
  for (const [name, hue] of Object.entries(HUES)) {
    const [, c, h] = toOklch(hue.printed);
    const dh = Math.abs(((h - hue.h + 540) % 360) - 180);
    assert.ok(dh < 1, `${name} sits ${dh.toFixed(1)}° from ${hue.from}'s printed ${hue.printed}`);
    assert.ok(Math.abs(c - hue.c) < 0.002, `${name}'s chroma is not ${hue.from}'s`);
  }
});

test("a step is one lightness in every hue", () => {
  // Unless sRGB cannot reach the chroma there, the lightness of a step does not depend on its hue:
  // that is what makes the red of a delay and the red of the 1 train the same red.
  for (const [name, hue] of Object.entries(HUES)) {
    for (const [step, L] of Object.entries(STEPS)) {
      const [l] = toOklch(oklch(L, hue.c, hue.h));
      assert.ok(Math.abs(l - L) < 0.01, `${name}-${step} came out at L ${l.toFixed(3)}, not ${L}`);
    }
  }
});

test("every trunk is a step of the ramp measured from its own printed colour", () => {
  const css = (name: string) => new RegExp(`--${name}:\\s*var\\(--([a-z]+)-\\d+\\)`).exec(tokens)?.[1];
  const hueOf: Record<string, string> = Object.fromEntries(Object.entries(HUES).map(([n, h]) => [h.from, n]));
  for (const t of Object.values(TRUNKS)) {
    const ramp = css(t.token.slice(2));
    assert.ok(ramp, `${t.token} does not name a ramp step`);
    if (ramp === "gray") continue;   // the L and the shuttles: the MTA's greys
    assert.equal(ramp, hueOf[t.name], `${t.name} is drawn from the ${ramp} ramp, not its own`);
    assert.ok(PALETTE[t.token], `${t.token} is missing from the canvas's palette`);
  }
});
