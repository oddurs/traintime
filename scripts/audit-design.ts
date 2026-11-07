/**
 * Design-system audit: every value in the stylesheet must come from the token layer.
 *
 * The tokens are declared once, in src/app/tokens.css, in three layers: primitives (named for
 * what they are), semantic tokens (named for what they are for, and built from primitives) and the
 * railway's own data colours. The stylesheet may use only the last two. Anything in it that spells out a colour, a
 * spacing, a radius, a type style or a duration by hand is a divergence — it is how an interface
 * drifts from a system into an assortment of near-misses, and it is invisible in review because
 * every individual value looks reasonable.
 *
 * Usage: npx tsx scripts/audit-design.ts [--fix-hints]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = join(process.cwd(), "src/app/globals.css");
const TOKENS = join(process.cwd(), "src/app/tokens.css");
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

/**
 * The token layer: what the system actually offers, and which of its three layers each token is
 * in. The layers are the sections of the file, marked by their headings.
 */
type Layer = "primitive" | "semantic" | "data";
const tokenSrc = readFileSync(TOKENS, "utf8");
const tokens = new Map<string, string>();
const layerOf = new Map<string, Layer>();
const tokenLine = new Map<string, number>();
{
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(tokenSrc);
  if (!root) throw new Error("no :root block in tokens.css — the token layer is the whole point");
  const first = tokenSrc.slice(0, root.index).split("\n").length;
  let layer: Layer | null = null;
  root[1].split("\n").forEach((l, i) => {
    const head = /^\s+(PRIMITIVES|SEMANTIC|DATA)\b/.exec(l);
    if (head) layer = head[1] === "PRIMITIVES" ? "primitive" : head[1] === "SEMANTIC" ? "semantic" : "data";
    const m = /^\s*--([\w-]+)\s*:\s*([^;]+);/.exec(l);
    if (!m) return;
    tokens.set(m[1], m[2].trim());
    tokenLine.set(m[1], first + i);
    if (layer) layerOf.set(m[1], layer);
  });
}
/** A token's value with every reference to another token replaced by what that token says. */
function resolve(value: string, depth = 0): string {
  return value.replace(/var\(--([\w-]+)\)/g, (whole, name: string) =>
    depth > 8 || !tokens.has(name) ? whole : resolve(tokens.get(name)!, depth + 1));
}
const tokenPx = new Set<number>();
for (const v of tokens.values()) for (const m of resolve(v).matchAll(/(-?[\d.]+)px/g)) tokenPx.add(Math.abs(Number(m[1])));

/**
 * Values a token would only obscure: a hairline is a hairline, and zero is zero. Everything
 * else has to be nameable.
 */
const RAW_PX_OK = new Set([0, 0.5, 1]);
/** Properties whose px values are layout, and so must come from the spacing or size scale. */
const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|flex-basis)(-(top|right|bottom|left|inline|block))?$/;

/** The one breakpoint, as declared; every media query that names a width has to say this one. */
const BREAKPOINT = Number(/(\d+)px/.exec(tokens.get("bp-phone") ?? "")?.[1] ?? NaN);

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
  // Tokens live in tokens.css. A :root here is a second token layer nobody would think to audit.
  if (/:root\s*\{/.test(raw)) findings.push({ line: n, kind: "layer", text: raw.trim(), detail: "tokens are declared in src/app/tokens.css, not here" });
  for (const m of raw.matchAll(/(?:max|min)-width:\s*(\d+)px/g)) {
    if (/@media/.test(raw) && Number(m[1]) !== BREAKPOINT) {
      findings.push({ line: n, kind: "breakpoint", text: raw.trim(), detail: `the one breakpoint is --bp-phone, ${BREAKPOINT}px` });
    }
  }
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
    // A component-local variable may name a semantic token, never a primitive.
    for (const v of value.matchAll(/var\(--([\w-]+)/g)) {
      if (layerOf.get(v[1]) === "primitive") {
        findings.push({ line: n, kind: "layer", text: `${prop}: ${value}`, detail: `--${v[1]} is a primitive; use the semantic token that says what it is for` });
      } else if (!tokens.has(v[1]) && !/^(row-inset|bullet-size|bullet-scale|brandmark-size|saved-h|peek-h|ds-[\w-]+|stripe-color|t-sample|tr-sample)$/.test(v[1])) {
        findings.push({ line: n, kind: "layer", text: `${prop}: ${value}`, detail: `--${v[1]} is not a token` });
      }
    }
    if (prop.startsWith("--")) continue;

    // Layers, weights and leading are named, like everything else.
    if (prop === "z-index" && !/^var\(--z-[\w-]+\)$/.test(value)) {
      findings.push({ line: n, kind: "layer", text: `${prop}: ${value}`, detail: "a z-index is one of the named --z- layers" });
    }
    if (prop === "font-weight" && !/^(var\(--w-[\w-]+\)|inherit|normal)$/.test(value)) {
      findings.push({ line: n, kind: "type", text: `${prop}: ${value}`, detail: "a weight is --w-strong or --w-heavy" });
    }
    if (prop === "line-height" && !/^(var\(--leading-[\w-]+\)|0|inherit|normal)$/.test(value)) {
      findings.push({ line: n, kind: "type", text: `${prop}: ${value}`, detail: "leading comes with the type role, or from --leading-" });
    }

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
        // An SVG mask is a stencil: its luminance says what survives, so its black and white are
        // arithmetic rather than design. Allowed only where they are named as such, so a real
        // colour cannot arrive under the same cover without saying out loud that it is a stencil.
        if (/\bSTENCIL_[A-Z]+\s*=/.test(line)) continue;
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
      // A computed key carries its cast — `["--x" as string]:` — and reading the property name off
      // the end of that finds "string", which is not a property anyone set.
      const body = m[1].replace(/\s+as\s+[\w.<>|[\]]+/g, "");
      for (const d of body.matchAll(/(\[?["']?[\w-]+)["']?\]?\s*:/g)) {
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
    } else if (norm(resolve(token)) !== norm(m[2])) {
      findings.push({ line, kind: "palette", file: rel, text: m[0], detail: `the stylesheet says ${resolve(token)}` });
    }
  }
}

/**
 * Every bullet is set in the ink the MTA prints.
 *
 * This used to be a contrast floor, and the floor was the wrong instrument. White on the G's
 * #6cbe45 measures 2.3 to 1 and on the L's #a7a9ac 2.4, so the floor demanded black on both — and
 * black on a G is not a more legible G, it is a bullet that does not exist. These marks are copied
 * from the platform signs; where legibility and fidelity disagree the sign wins, and the fix for a
 * dim bullet is its size, not its ink.
 *
 * So the rule is a property of the ground: black only where the colour is genuinely light, which
 * across the whole system means the yellow and nothing else. Stated as a threshold rather than a
 * list, so a trunk added later is checked rather than merely absent from an exception list.
 *
 * (This clause was also in the file twice, verbatim, quietly reporting everything it found twice.)
 */
{
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * srgb(((n >> 16) & 255) / 255) + 0.7152 * srgb(((n >> 8) & 255) / 255) + 0.0722 * srgb((n & 255) / 255);
  };
  const trunks = readFileSync(join(process.cwd(), "src/lib/trunks.ts"), "utf8");
  const pal = readFileSync(join(process.cwd(), "src/lib/palette.ts"), "utf8");
  const colourOf = new Map<string, string>();
  for (const m of pal.matchAll(/"(--[\w-]+)":\s*"(#[0-9a-fA-F]{6})"/g)) colourOf.set(m[1], m[2]);
  /*
   * Where the ink turns over. The Broadway yellow sits at 0.64 and the next lightest ground in the
   * system — the crosstown green at 0.40 and the Canarsie grey at 0.40 — are far below it, so the
   * threshold is nowhere near anything it has to separate finely.
   */
  const LIGHT_GROUND = 0.5;
  for (const m of trunks.matchAll(/(\w+):\s*\{\s*name:\s*"([^"]+)",\s*token:\s*"(--[\w-]+)"(?:,\s*lineToken:\s*"--[\w-]+")?,\s*ink:\s*"(light|dark)"/g)) {
    const [, id, , token, which] = m;
    const ground = colourOf.get(token);
    if (!ground) continue;
    const want = lum(ground) > LIGHT_GROUND ? "dark" : "light";
    if (which === want) continue;
    const line = trunks.slice(0, m.index).split("\n").length;
    findings.push({
      line, kind: "ink", file: "src/lib/trunks.ts",
      text: `${id}: ${which} ink on ${ground}`,
      detail: `the MTA sets this one in ${want} — its ground has luminance ${lum(ground).toFixed(2)}`,
    });
  }
}

/**
 * The roundel's proportions, in TypeScript, against the same numbers in the stylesheet.
 *
 * A route bullet in the panel is drawn by CSS and a train marker on the map by an expression, so
 * the ratio between a character and its diameter has to exist in both languages. It is declared
 * once in src/lib/roundel.ts and mirrored as tokens; without this check the two drift and the same
 * service reads as two different marks depending on where you look at it.
 */
{
  const rel = "src/lib/roundel.ts";
  let text = "";
  try { text = readFileSync(join(process.cwd(), rel), "utf8"); } catch { text = ""; }
  const spec = new Map<string, string>();
  for (const m of text.matchAll(/^\s*(\w+):\s*([\d.]+),/gm)) spec.set(m[1], m[2]);
  const dashed = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  for (const [name, value] of spec) {
    if (name === "capHeight") continue;
    const token = tokens.get(`roundel-${dashed(name)}`);
    const line = text.slice(0, text.indexOf(`${name}:`)).split("\n").length;
    if (token === undefined) {
      findings.push({ line, kind: "roundel", file: rel, text: `${name}: ${value}`, detail: `--roundel-${dashed(name)} is not a token` });
    } else if (Number(token) !== Number(value)) {
      findings.push({ line, kind: "roundel", file: rel, text: `${name}: ${value}`, detail: `the stylesheet says ${token}` });
    }
  }
}

/**
 * ---- The token layer against itself. ----
 *
 * The rules above keep the stylesheet inside the tokens. These keep the tokens honest: a semantic
 * token that spells out its own colour is a primitive in disguise, and a theme would have to find
 * it; a type role under the floor is fine print; a token nobody uses is permanent.
 */
{
  const at = (name: string) => ({ line: tokenLine.get(name) ?? 0, file: "src/app/tokens.css" });

  for (const [name, value] of tokens) {
    if (layerOf.get(name) === "semantic" && /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(value)) {
      findings.push({ ...at(name), kind: "layer", text: `--${name}: ${value}`, detail: "a semantic colour names a primitive; it does not spell one out" });
    }
  }

  /*
   * The floor. Nothing is set under 12 px — Apple's smallest text size, and the size under which
   * a label stops being read and starts being deciphered. The roles are checked as resolved, so
   * a primitive that shrinks moves every role that uses it into view here.
   */
  const FLOOR_PX = 12;
  const px = (v: string) => (v.endsWith("rem") ? parseFloat(v) * 16 : parseFloat(v));
  for (const name of [...tokens.keys()].filter((k) => k.startsWith("t-"))) {
    const font = resolve(tokens.get(name)!);
    const size = /(clamp\(([^,]+),[^)]*\)|[\d.]+(?:rem|px))\s*\//.exec(font);
    if (!size) {
      findings.push({ ...at(name), kind: "type-floor", text: `--${name}: ${font}`, detail: "no size could be read from it — is a token it names missing?" });
      continue;
    }
    const smallest = px((size[2] ?? size[1]).trim());
    if (!(smallest >= FLOOR_PX)) {
      findings.push({ ...at(name), kind: "type-floor", text: `--${name}`, detail: `sets text at ${smallest}px, under the ${FLOOR_PX}px floor` });
    }
  }

  /* The breakpoint, where the script that runs before the stylesheet writes it again. */
  const fp = readFileSync(join(process.cwd(), "src/lib/firstPaint.ts"), "utf8");
  const q = /PHONE_QUERY\s*=\s*"\(max-width:\s*(\d+)px\)"/.exec(fp);
  if (!q || Number(q[1]) !== BREAKPOINT) {
    findings.push({ line: 0, file: "src/lib/firstPaint.ts", kind: "breakpoint", text: q?.[0] ?? "PHONE_QUERY", detail: `must say ${BREAKPOINT}px, as --bp-phone does` });
  }

  /*
   * Unused tokens. A primitive is used when a semantic or data token names it; anything else is
   * used when the stylesheet, another token or a component does. A component that builds a name
   * — `var(--bullet-${size})` — keeps every token with that prefix. The /design page documents
   * tokens and so does not count: documentation is not a use.
   */
  const code = sources.filter((r) => !r.startsWith("src/app/design/")).map((r) => readFileSync(join(process.cwd(), r), "utf8")).join("\n");
  const prefixes = [...code.matchAll(/--([\w-]+-)\$\{/g)].map((m) => m[1]);
  const tokenValues = [...tokens.values()].join("\n");
  // The stylesheet and the token values reference with var(); the canvas and inline styles by name.
  const referenced = (name: string) =>
    src.includes(`var(--${name})`) || tokenValues.includes(`var(--${name})`)
    || new RegExp(`["'\`(]--${name}["'\`)]`).test(code) || prefixes.some((p) => name.startsWith(p));
  for (const name of tokens.keys()) {
    if (name === "bp-phone") continue;   // read by this audit, since a media query cannot read it
    if (layerOf.get(name) === "primitive" ? !tokenValues.includes(`var(--${name})`) : !referenced(name)) {
      findings.push({ ...at(name), kind: "unused", text: `--${name}`, detail: "nothing uses it: delete it, or use it" });
    }
  }
}

/**
 * ---- Contrast, measured. ----
 *
 * Every label and every status colour, on every surface it is set on, at 4.5:1 or better — the
 * bar for text of any size. The surfaces are the solid ones and the fills composited over them,
 * which is what a reader actually sees; a material over the map is checked over the map's black.
 */
{
  type RGBA = [number, number, number, number];
  const parse = (v: string): RGBA | null => {
    v = v.trim();
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    m = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
    if (m) { const c = parse(m[1]); return c ? [c[0], c[1], c[2], c[3] * Number(m[2]) / 100] : null; }
    return null;
  };
  const colour = (name: string) => parse(resolve(tokens.get(name) ?? ""));
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = (c: RGBA) => {
    const ch = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const ground = colour("ground")!, panel = colour("surface-solid")!;
  const SURFACES: [string, RGBA][] = [
    ["--ground", ground],
    ["--surface-solid", panel],
    ["--surface-sunken", colour("surface-sunken")!],
    ["--fill on --surface-solid", over(colour("fill")!, panel)],
    ["--fill-2 on --surface-solid", over(colour("fill-2")!, panel)],
    ["--mat-regular on --ground", over(colour("mat-regular")!, ground)],
  ];
  const TEXT = ["label", "label-2", "label-3", "accent", "green", "amber", "red"];
  const MIN = 4.5;
  for (const t of TEXT) {
    const c = colour(t);
    if (!c) { findings.push({ ...{ line: tokenLine.get(t) ?? 0, file: "src/app/tokens.css" }, kind: "contrast", text: `--${t}`, detail: "could not be read as a colour" }); continue; }
    for (const [where, s] of SURFACES) {
      const r = ratio(over(c, s), s);
      if (r < MIN) findings.push({ line: tokenLine.get(t) ?? 0, file: "src/app/tokens.css", kind: "contrast", text: `--${t} on ${where}`, detail: `${r.toFixed(2)}:1, under ${MIN}:1` });
    }
  }
}

const byKind = new Map<string, Finding[]>();
for (const f of findings) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)!).push(f);
const order = ["layer", "duplicate", "colour", "raw-control", "palette", "contrast", "type-floor", "unknown-class", "inline-style", "type", "tracking", "spacing", "radius", "motion", "breakpoint", "unused", "tap-target"];
// A kind that is not in the list is still a failure, so it is still printed.
for (const k of byKind.keys()) if (!order.includes(k)) order.push(k);

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
