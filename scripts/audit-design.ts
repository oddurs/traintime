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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = join(process.cwd(), "src/app/globals.css");
/** Where the primitives live. These are allowed to render raw elements; nothing else is. */
const UI_DIR = "src/components/ui/";
/**
 * The one file allowed to write colours out by hand — the canvas, the manifest and the document
 * head cannot read CSS. Its literals are checked against the stylesheet further down, so the copy
 * cannot drift from the original without failing the build.
 */
const PALETTE_SOURCE = "src/lib/palette.ts";
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
const seen = new Map<string, Map<string, number>>();  // scope -> prop -> where it was last set
/**
 * The open blocks, innermost last.
 *
 * This used to be two strings — a selector and one enclosing at-rule — closed by a line that was
 * nothing but `}`. A rule written on one line opened a block that nothing closed, so the at-rule
 * context leaked into every rule after it, and two rules in genuinely different scopes were
 * reported as one setting the same property twice. Counting braces is the only version of this
 * that is actually right.
 */
const stack: string[] = [];

lines.forEach((raw, i) => {
  const n = i + 1;
  if (i >= rootStart && i <= rootEnd) return;
  const line = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/^\s*\/\*|^\s*\*/.test(raw)) return;
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  // Rules nested in a media query are indented, so the selector has to be matched with leading
  // space allowed — without that every rule in the query was attributed to the query itself.
  const sel = /^\s*([.#:*@\w][^{]*)\{/.exec(line);
  for (let k = 0; k < opens; k++) stack.push(sel ? sel[1].trim() : "?");
  const selector = [...stack].reverse().find((f) => !f.startsWith("@")) ?? "";
  const scope = stack.join(" ");

  for (const d of line.matchAll(/([-\w]+)\s*:\s*([^;{}]+)[;}]/g)) {
    /* Where this declaration is, exactly: two on one line are still two. */
    const at = n * 100_000 + (d.index ?? 0);
    const prop = d[1].toLowerCase();
    const value = d[2].trim();
    if (prop.startsWith("--")) continue;

    // A rule that declares the same property twice: one of them is dead, and which one is
    // whichever came last, which is never what anybody meant.
    if (selector) {
      const per = seen.get(scope) ?? seen.set(scope, new Map()).get(scope)!;
      const prev = per.get(prop);
      if (prev !== undefined && prev !== at) {
        const where = Math.floor(prev / 100_000);
        findings.push({
          line: n, kind: "duplicate", text: `${selector} { ${prop} }`,
          detail: where === n ? "set twice on this line" : `also set on line ${where}`,
        });
      }
      per.set(prop, at);
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

  for (let k = 0; k < closes; k++) stack.pop();
});

/**
 * ---- The component layer. ----
 *
 * A stylesheet that passes every rule above is still only half a design system: the other half is
 * whether the components use it. Everything here is about that half — a colour written into a
 * component, a raw <button> that skips the button vocabulary, an inline size, or a class name
 * that no longer exists in the stylesheet. None of it is visible in a CSS-only audit, and all of
 * it is how an interface drifts back out of a system it was just brought into.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}
const sources = walk("src").sort();

/** Every class the stylesheet actually defines. */
const cssClasses = new Set<string>();
for (const m of src.matchAll(/\.([A-Za-z][\w-]*)/g)) cssClasses.add(m[1]);
/* MapLibre brings its own, and the map is not ours to rename. */
for (const m of src.matchAll(/maplibregl-[\w-]+/g)) cssClasses.add(m[0]);

/** Read the balanced value of `className=` — a quoted string, or a braced expression. */
function classAttrs(text: string): { value: string; line: number; literal: boolean }[] {
  const out: { value: string; line: number; literal: boolean }[] = [];
  const re = /className[=:]\s*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    const line = text.slice(0, i).split("\n").length;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      const end = text.indexOf(q, i + 1);
      if (end < 0) continue;
      // A quoted attribute is the class list itself, not an expression that mentions one.
      out.push({ value: text.slice(i + 1, end), line, literal: true });
    } else if (text[i] === "{") {
      let depth = 0;
      const start = i;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) { i++; break; }
      }
      out.push({ value: text.slice(start, i), line, literal: false });
    }
  }
  return out;
}

/**
 * The class names an expression can produce.
 *
 * Only literals count: a quoted string anywhere in the expression, and the static prefix of a
 * template before its first substitution. Anything after a `${` is a value, not a name — reading
 * it would report the variables themselves as missing classes.
 */
function plainClasses(value: string): string[] {
  return value.split(/\s+/).filter((c) => /^[a-z][\w-]*$/.test(c));
}

function literalClasses(expr: string): string[] {
  const parts: string[] = [];
  for (const m of expr.matchAll(/"([^"]*)"|'([^']*)'/g)) parts.push(m[1] ?? m[2] ?? "");
  for (const m of expr.matchAll(/`([^`]*)`/g)) parts.push(m[1].split("${")[0]);
  return parts
    .flatMap((p) => p.split(/\s+/))
    .filter((c) => /^[a-z][\w-]*$/.test(c) && !c.endsWith("-"));
}

/** Properties an inline style may set: the ones that carry live data and cannot be a class. */
const INLINE_OK = /^(width|height|left|top|transform|--)/;

for (const rel of sources) {
  const text = readFileSync(join(process.cwd(), rel), "utf8");
  const lines = text.split("\n");
  const inUi = rel.startsWith(UI_DIR);

  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/^\s*(\*|\/\/)/.test(raw)) return;
    const line = raw.replace(/\/\*[\s\S]*?\*\//g, "");

    // Colours. One file is allowed them, because it is the one that reads them back.
    if (rel !== PALETTE_SOURCE) {
      for (const c of line.matchAll(/["'`]#[0-9a-fA-F]{3,8}["'`]|["'`]rgba?\([^)]*\)["'`]/g)) {
        if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c[0])) continue;
        findings.push({ line: n, kind: "colour", file: rel, text: line.trim().slice(0, 70), detail: `${c[0]} should come from the token layer` });
      }
    }

    // Raw controls. The primitives are the only way to get one.
    if (!inUi) {
      for (const m of line.matchAll(/<(button|input|select)[\s>]/g)) {
        findings.push({ line: n, kind: "raw-control", file: rel, text: line.trim().slice(0, 70), detail: `<${m[1]}> should come from src/components/ui` });
      }
    }

    // Inline styles. A width driven by live data is fine; a size or a colour is a token.
    for (const m of line.matchAll(/style=\{\{([^}]*)\}/g)) {
      for (const d of m[1].matchAll(/(\[?["']?[\w-]+)["']?\]?\s*:/g)) {
        const prop = d[1].replace(/^\[?["']?/, "");
        if (INLINE_OK.test(prop)) continue;
        findings.push({ line: n, kind: "inline-style", file: rel, text: line.trim().slice(0, 70), detail: `${prop} belongs in the stylesheet` });
      }
    }
  });

  // Class names that the stylesheet no longer defines: a rule deleted out from under a component
  // leaves markup that looks styled and is not, and nothing else in the build notices.
  for (const { value, line, literal } of classAttrs(text)) {
    for (const c of literal ? plainClasses(value) : literalClasses(value)) {
      if (cssClasses.has(c)) continue;
      findings.push({ line, kind: "unknown-class", file: rel, text: value.slice(0, 70), detail: `.${c} is not in the stylesheet` });
    }
  }

  // The same, for a class list assembled into a variable before it is used.
  for (const m of text.matchAll(/\[([^\[\]]*)\]\s*\.filter\(Boolean\)\s*\.join\(" "\)/g)) {
    const line = text.slice(0, m.index).split("\n").length;
    for (const c of literalClasses(m[1])) {
      if (cssClasses.has(c)) continue;
      findings.push({ line, kind: "unknown-class", file: rel, text: m[1].slice(0, 70), detail: `.${c} is not in the stylesheet` });
    }
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
  // Every step, including the ones whose tracking is currently zero. Exempting those left the
  // rule blind exactly where most of the text is: body and caption could be set with any tracking
  // at all and nothing would notice. A zero that is declared is a decision; a zero that is
  // inferred is a gap.
  const tracked = new Set([...tokens.keys()].filter((k) => k.startsWith("tr-")).map((k) => k.slice(3)));
  /*
   * A step with no tracking token is not an exemption, it is a missing half of the pair. Deleting
   * `--tr-title` used to switch the rule off for every rule that used `--t-title`, silently — the
   * audit went on passing while the scale came apart underneath it.
   */
  for (const step of [...tokens.keys()].filter((k) => k.startsWith("t-")).map((k) => k.slice(2))) {
    if (tracked.has(step)) continue;
    const line = src.slice(0, src.indexOf(`--t-${step}:`)).split("\n").length;
    findings.push({ line, kind: "tracking", text: `--t-${step}`, detail: `has no --tr-${step} to go with it` });
  }
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

/**
 * The palette module against the stylesheet.
 *
 * src/lib/palette.ts holds the three or four colours that genuinely cannot be read out of CSS at
 * run time — the canvas, the manifest, the theme colour in the document head. It is a copy, and a
 * copy is only safe while something checks it, so every entry is compared with the token of the
 * same name here.
 */
{
  const rel = "src/lib/palette.ts";
  let text = "";
  try { text = readFileSync(join(process.cwd(), rel), "utf8"); } catch { text = ""; }
  const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
  for (const m of text.matchAll(/"(--[\w-]+)":\s*"([^"]+)"/g)) {
    const token = tokens.get(m[1].slice(2));
    const line = text.slice(0, m.index).split("\n").length;
    if (token === undefined) {
      findings.push({ line, kind: "palette", file: rel, text: m[0], detail: `--${m[1].slice(2)} is not a token` });
    } else if (norm(token) !== norm(m[2])) {
      findings.push({ line, kind: "palette", file: rel, text: m[0], detail: `the stylesheet says ${token}` });
    }
  }
}

const byKind = new Map<string, Finding[]>();
for (const f of findings) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)!).push(f);
const order = ["duplicate", "colour", "raw-control", "palette", "unknown-class", "inline-style", "type", "tracking", "spacing", "radius", "motion", "tap-target"];

console.log(`design audit — ${tokens.size} tokens, ${cssClasses.size} classes, ${sources.length} components, ${findings.length} divergences\n`);
for (const kind of order) {
  const list = byKind.get(kind);
  if (!list?.length) continue;
  console.log(`  [${kind}] ${list.length}`);
  for (const f of list.slice(0, 12)) console.log(`      ${f.file ?? "globals.css"}:${f.line}  ${f.text}  — ${f.detail}`);
  if (list.length > 12) console.log(`      … and ${list.length - 12} more`);
  console.log("");
}
if (!findings.length) console.log("  PASS — every value comes from the token layer, and every component from the primitives\n");
process.exit(findings.length ? 1 : 0);
