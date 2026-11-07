/**
 * The colour system, as numbers — grounded in the MTA's.
 *
 * Every colour in bound, the railway's lines and the interface's own, is a step on one of these
 * ramps. A ramp is a hue and a chroma; a step is a lightness. The hues and chromas are the MTA's,
 * measured from the colours the agency prints for its trunk lines, so the system starts from the
 * subway's own palette rather than from a UI kit's. What is adjusted for a dark web interface is
 * lightness alone: the printed colours range from 0.40 (8 Avenue's navy, which vanishes on black)
 * to 0.86 (Broadway's yellow), and a screen needs them in a band where a line reads on black and a
 * white letter reads on the bullet.
 *
 * It is all OKLCH, the space in which equal lightness looks equally light whatever the hue. So the
 * red of the 1 train and the red of a delay are one red, and a 500 is as bright in blue as in orange.
 *
 * The values here generate the primitive layer of src/app/tokens.css (scripts/build-palette.ts),
 * and tests/palette.test.ts fails if the two have drifted. To tweak a colour, change it here and
 * run `npm run build:palette`.
 */

/** Lightness for each step, in OKLCH L. Larger numbers are darker, as in every ramp. */
export const STEPS = { 100: 0.93, 200: 0.87, 300: 0.8, 400: 0.72, 500: 0.64, 600: 0.56, 700: 0.48, 800: 0.4 } as const;
export type Step = keyof typeof STEPS;

export interface Hue {
  /** OKLCH hue angle, in degrees. */
  h: number;
  /** The most chroma the ramp may use. A step takes this, or the most sRGB can show at its lightness. */
  c: number;
  /** The trunk whose printed colour the hue and chroma are measured from, and that colour. */
  from: string;
  printed: string;
}

export const HUES = {
  red: { h: 28, c: 0.221, from: "Broadway–7 Avenue", printed: "#ee352e" },
  orange: { h: 41, c: 0.204, from: "6 Avenue", printed: "#ff6319" },
  brown: { h: 64, c: 0.094, from: "Nassau Street", printed: "#996633" },
  yellow: { h: 91, c: 0.175, from: "Broadway", printed: "#fccc0a" },
  lime: { h: 137, c: 0.176, from: "Brooklyn–Queens Crosstown", printed: "#6cbe45" },
  green: { h: 149, c: 0.165, from: "Lexington Avenue", printed: "#00933c" },
  sky: { h: 248, c: 0.149, from: "Staten Island Railway", printed: "#0078c6" },
  blue: { h: 262, c: 0.183, from: "8 Avenue", printed: "#0039a6" },
  purple: { h: 332, c: 0.214, from: "Flushing", printed: "#b933ad" },
} as const satisfies Record<string, Hue>;
export type HueName = keyof typeof HUES;

/**
 * The neutral ramp, on the hue of the MTA's own greys (the L and the shuttles), at a trace of its
 * chroma, so the interface's greys and the railway's are one family.
 */
export const NEUTRAL = { h: 262, c: 0.005 };
export const GRAYS = {
  50: 0.971, 300: 0.839, 400: 0.773, 500: 0.689, 600: 0.62, 700: 0.54, 850: 0.202, 900: 0.175, 950: 0.151, 1000: 0,
} as const;
export type GrayStep = keyof typeof GRAYS;

/* ---- OKLCH to sRGB (Björn Ottosson's OKLab), with chroma reduced until the colour is in gamut. ---- */

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const inGamut = (rgb: number[]) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

export function oklch(L: number, C: number, h: number): string {
  const lin = (c: number) => {
    const rad = (h * Math.PI) / 180;
    return oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
  };
  let c = C;
  if (!inGamut(lin(c))) {
    let lo = 0, hi = C;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (inGamut(lin(mid))) lo = mid; else hi = mid; }
    c = lo;
  }
  const hex = lin(c).map((x) => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255).toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

/** Every primitive colour the ramps define, by token name: `red-500`, `gray-850`. */
export function rampColours(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, hue] of Object.entries(HUES)) {
    for (const [step, L] of Object.entries(STEPS)) out.set(`${name}-${step}`, oklch(L, hue.c, hue.h));
  }
  for (const [step, L] of Object.entries(GRAYS)) out.set(`gray-${step}`, oklch(L, L === 0 ? 0 : NEUTRAL.c, NEUTRAL.h));
  return out;
}

/** OKLCH of an sRGB hex colour — for measuring where an existing colour sits. */
export function toOklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/* ---- Writing the generated layer. ---- */

const BEGIN = "/* @generated ramps: scripts/build-palette.ts from src/lib/ramps.ts. Do not edit by hand. */";
const END = "/* @end generated ramps */";

/**
 * The primitive colour block of tokens.css: every ramp step that some token in the file names, and
 * no others. The ramps define nine hues of eight steps; a step nobody uses would be a token the
 * audit rightly calls dead, so only the ones in use are written.
 */
export function renderRampBlock(tokensCss: string): string {
  const start = tokensCss.indexOf(BEGIN), end = tokensCss.indexOf(END);
  if (start < 0 || end < 0) throw new Error("tokens.css has no generated ramp block markers");
  const outside = tokensCss.slice(0, start) + tokensCss.slice(end);
  const all = rampColours();
  const used = new Set([...outside.matchAll(/var\(--([a-z]+-\d+)\)/g)].map((m) => m[1]).filter((n) => all.has(n)));
  const order = [...all.keys()];
  const lines = order.filter((n) => used.has(n)).map((n) => `  --${n}: ${all.get(n)};`);
  return tokensCss.slice(0, start) + BEGIN + "\n" + lines.join("\n") + "\n  " + tokensCss.slice(end);
}

/** A token's value with every var() replaced by what it names, read from the token file. */
export function resolveToken(tokensCss: string, name: string, depth = 0): string | undefined {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss);
  if (!m) return undefined;
  return m[1].trim().replace(/var\(--([\w-]+)\)/g, (whole, n: string) =>
    depth > 8 ? whole : resolveToken(tokensCss, n, depth + 1) ?? whole);
}

/**
 * src/lib/palette.ts, with every literal set to what its token resolves to. The canvas, the
 * manifest and the document head cannot read CSS, so they read this copy; it is written, not kept.
 */
export function renderPalette(paletteTs: string, tokensCss: string): string {
  return paletteTs.replace(/"(--[\w-]+)":\s*"([^"]+)"/g, (whole, name: string) => {
    const v = resolveToken(tokensCss, name.slice(2));
    return v === undefined ? whole : `"${name}": "${v}"`;
  });
}
