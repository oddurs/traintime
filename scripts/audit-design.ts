/**
 * Design-system audit: every value in the stylesheet must come from the token layer.
 *
 * The tokens are declared once in `:root`. Anything outside it that spells out a colour, a
 * spacing, a radius, a type style or a duration by hand is a divergence — it is how an interface
 * drifts from a system into an assortment of near-misses, and it is invisible in review because
 * every individual value looks reasonable.
 *
 * Usage: npx tsx scripts/audit-design.ts [--fix-hints]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = join(process.cwd(), "src/app/globals.css");
/**
 * The map is styled in TypeScript, not CSS, because MapLibre paints into a canvas. That put a
 * second palette in the codebase that this audit could not see — station fills, label colours and
 * halos written out as literals. They are read from the token layer through src/lib/mapTheme.ts
 * now, and these files are checked so they stay that way.
 */
const THEMED_TS = ["src/components/TrainMap.tsx", "src/lib/icons.ts"];
const src = readFileSync(CSS, "utf8");
const lines = src.split("\n");

interface Finding { line: number; kind: string; text: string; detail: string; file?: string }
const findings: Finding[] = [];

/** The token layer: what the system actually offers. */
const tokens = new Map<string, string>();
{
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!root) throw new Error("no :root block — the token layer is the whole point");
  for (const m of root[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
}
const tokenPx = new Set<number>();
for (const v of tokens.values()) for (const m of v.matchAll(/(-?[\d.]+)px/g)) tokenPx.add(Math.abs(Number(m[1])));

/**
 * Values a token would only obscure: a hairline is a hairline, and zero is zero. Everything
 * else has to be nameable.
 */
const RAW_PX_OK = new Set([0, 0.5, 1]);
/** Properties whose px values are layout, and so must come from the spacing or size scale. */
const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|flex-basis)(-(top|right|bottom|left|inline|block))?$/;

/** Where in the file the `:root` block sits, so it can be skipped. */
const rootStart = lines.findIndex((l) => /:root\s*\{/.test(l));
let rootEnd = rootStart;
for (let i = rootStart; i < lines.length; i++) if (/^\}/.test(lines[i])) { rootEnd = i; break; }

/** Declarations seen per selector, to catch a rule that sets the same thing twice. */
const seen = new Map<string, Map<string, number>>();
let selector = "";
/** The enclosing at-rule, so that a media query legitimately overriding a desktop rule is not
 *  mistaken for a rule that contradicts itself. */
let context = "";

lines.forEach((raw, i) => {
  const n = i + 1;
  if (i >= rootStart && i <= rootEnd) return;
  const line = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/^\s*\/\*|^\s*\*/.test(raw)) return;
  // Rules nested in a media query are indented, so the selector has to be matched with leading
  // space allowed — without that every rule in the query was attributed to the query itself and
  // reported as a pile of duplicates.
  const sel = /^\s*([.#:*@\w][^{]*)\{/.exec(line);
  if (sel) {
    const name = sel[1].trim();
    if (name.startsWith("@")) context = name;
    else selector = name;
  }
  if (/^\s*\}\s*$/.test(line)) { if (selector) selector = ""; else context = ""; }

  for (const d of line.matchAll(/([-\w]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const prop = d[1].toLowerCase();
    const value = d[2].trim();
    if (prop.startsWith("--")) continue;

    // A rule that declares the same property twice: one of them is dead, and which one is
    // whichever came last, which is never what anybody meant.
    if (selector) {
      const scope = `${context}|${selector}`;
      const per = seen.get(scope) ?? seen.set(scope, new Map()).get(scope)!;
      if (per.has(prop) && per.get(prop) !== n) {
        findings.push({ line: n, kind: "duplicate", text: `${selector} { ${prop} }`, detail: `also set on line ${per.get(prop)}` });
      }
      per.set(prop, n);
    }

    // Colours.
    if (!/^--/.test(prop)) {
      for (const c of value.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)) {
        if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(c[0])) continue;
        findings.push({ line: n, kind: "colour", text: `${prop}: ${value}`, detail: `${c[0]} is not a token` });
      }
    }

    // Spacing and sizes.
    if (SPACING_PROPS.test(prop)) {
      for (const m of value.matchAll(/(-?[\d.]+)px/g)) {
        const px = Math.abs(Number(m[1]));
        if (RAW_PX_OK.has(px) || tokenPx.has(px)) continue;
        findings.push({ line: n, kind: "spacing", text: `${prop}: ${value}`, detail: `${m[0]} is not on the scale` });
      }
    }

    // Radii.
    if (prop === "border-radius" && /\dpx/.test(value) && !value.includes("var(--r-")) {
      for (const m of value.matchAll(/([\d.]+)px/g)) {
        if (RAW_PX_OK.has(Number(m[1])) || tokenPx.has(Number(m[1]))) continue;
        findings.push({ line: n, kind: "radius", text: `${prop}: ${value}`, detail: `${m[0]} is not a named radius` });
      }
    }

    // Type. Every piece of text in the app should be one of the named styles.
    if ((prop === "font" || prop === "font-size") && !value.includes("var(--t-") && !/^(inherit|inherit .*)$/.test(value)) {
      findings.push({ line: n, kind: "type", text: `${prop}: ${value}`, detail: "not one of the named type styles" });
    }

    // Motion.
    if (prop === "transition" || prop === "animation" || prop === "transition-duration") {
      // A system may have more than two durations; what it may not have is a number typed in
      // by hand, because that is how twelve slightly different speeds get into an interface.
      if (/[\d.]+m?s(\s|$|,|\))/.test(value.replace(/var\([^)]*\)/g, "")) ) {
        findings.push({ line: n, kind: "motion", text: `${prop}: ${value}`, detail: "duration is not a token" });
      }
      if (/cubic-bezier|ease-in|ease-out\b/.test(value) && !value.includes("var(--ease)")) {
        findings.push({ line: n, kind: "motion", text: `${prop}: ${value}`, detail: "easing is not the system curve" });
      }
    }
  }
});

{
  for (const rel of THEMED_TS) {
    let text: string;
    try { text = readFileSync(join(process.cwd(), rel), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      for (const c of line.matchAll(/"#[0-9a-fA-F]{3,8}"|"rgba?\([^)]*\)"/g)) {
        // Fully transparent is "no fill", not a colour anybody chose.
        if (/^"rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)"$/.test(c[0])) continue;
        findings.push({ line: i + 1, kind: "colour", file: rel, text: line.trim().slice(0, 70), detail: `${c[0]} should come from mapTheme()` });
      }
    });
  }
}

/**
 * Type styles carry their tracking with them.
 *
 * Helvetica is drawn for signage: it sets loose at small sizes and looks loose at large ones, so
 * each step of the scale has a tracking that belongs to it. Using the size without the tracking is
 * how a scale quietly stops being one — the sizes stay right and the texture drifts.
 */
{
  const tracked = new Set(
    [...tokens.keys()].filter((k) => k.startsWith("tr-") && !/^0(em)?$/.test(tokens.get(k) ?? "")).map((k) => k.slice(3)),
  );
  for (const block of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim().split("\n").pop()!.trim();
    if (selector.startsWith("@") || selector.startsWith(":root")) continue;
    const decls = block[2];
    const font = /font:\s*var\(--t-([\w-]+)\)/.exec(decls);
    if (!font || !tracked.has(font[1])) continue;
    if (decls.includes(`var(--tr-${font[1]})`)) continue;
    // Set in capitals, text wants the looser tracking of the caps step whatever its size — that
    // is a typographic decision, not a drift, so it is allowed explicitly.
    if (/text-transform:\s*uppercase/.test(decls) && decls.includes("var(--tr-micro)")) continue;
    const line = src.slice(0, block.index).split("\n").length;
    findings.push({
      line, kind: "tracking", text: `${selector} { font: var(--t-${font[1]}) }`,
      detail: `needs letter-spacing: var(--tr-${font[1]})`,
    });
  }
}

/** Anything a finger lands on has to be big enough to land on. */
const TAP_MIN = Number(/(\d+)px/.exec(tokens.get("tap") ?? "44px")?.[1] ?? 44);
lines.forEach((raw, i) => {
  const m = /min-height:\s*(\d+)px/.exec(raw);
  if (!m) return;
  const px = Number(m[1]);
  if (px >= TAP_MIN) return;
  // Only interactive things need the full target; a bar in a chart does not.
  if (!/button|input|select|\.check|\.chip|\.near-btn|a\b/.test(raw)) return;
  findings.push({ line: i + 1, kind: "tap-target", text: raw.trim().slice(0, 90), detail: `${px}px is under the ${TAP_MIN}px target` });
});

const byKind = new Map<string, Finding[]>();
for (const f of findings) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)!).push(f);
const order = ["duplicate", "colour", "type", "tracking", "spacing", "radius", "motion", "tap-target"];

console.log(`design audit — ${tokens.size} tokens, ${findings.length} divergences\n`);
for (const kind of order) {
  const list = byKind.get(kind);
  if (!list?.length) continue;
  console.log(`  [${kind}] ${list.length}`);
  for (const f of list.slice(0, 12)) console.log(`      ${f.file ?? "globals.css"}:${f.line}  ${f.text}  — ${f.detail}`);
  if (list.length > 12) console.log(`      … and ${list.length - 12} more`);
  console.log("");
}
if (!findings.length) console.log("  PASS — every value comes from the token layer\n");
process.exit(findings.length ? 1 : 0);
