/**
 * Turn the evaluator's reports into the public accuracy page's data.
 * Run after `npm run evaluate`; writes public/data/accuracy.json.
 *
 *   npx tsx scripts/publish-accuracy.ts [--report kinematic-timing-model] [--baseline naive]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EVAL_DIR = join(ROOT, "data", "eval");
const OUT = join(ROOT, "public", "data", "accuracy.json");

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[++i] ?? "true");
}

interface EtaRow { n: number; rawMae: number; rawBias: number; adjMae: number; adjBias: number; coverage: number }
interface Report {
  name: string; variant: string; timing: boolean; model: boolean;
  window: { from: number; to: number }; ticks: number; arrivals: number;
  position: { n: number; behindSegment: number; shortMedianM: number; shortP90M: number; earlyShare: number; earlyMedianS: number };
  motion: { steps: number; reversals: number; jumps: number; coldPlacements: number; maxSpeedMps: number; maxAccelMps2: number };
  dataLatencyS: { median: number; p90: number };
  eta: Record<string, EtaRow>;
}

const LABELS: Record<string, string> = { h0: "under 45 s", h1: "45 s – 2 min", h2: "2 – 5 min", h3: "5 – 15 min", h4: "over 15 min" };

function load(name: string): Report | null {
  const p = join(EVAL_DIR, `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Report) : null;
}

function main() {
  if (!existsSync(EVAL_DIR)) { console.error("no data/eval — run `npm run evaluate` first"); process.exit(1); }
  const available = readdirSync(EVAL_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  const preferred = args.get("report") ?? ["kinematic-timing-model", "kinematic-timing", "kinematic-raw"].find((n) => available.includes(n));
  if (!preferred) { console.error(`no usable report in data/eval (found: ${available.join(", ") || "none"})`); process.exit(1); }
  const main_ = load(preferred);
  if (!main_) { console.error(`report ${preferred} not found`); process.exit(1); }
  const baseline = load(args.get("baseline") ?? "baseline-naive");

  const timingPath = join(ROOT, "data", "timing.json");
  const modelPath = join(ROOT, "data", "eta-model.json");
  const timing = existsSync(timingPath) ? JSON.parse(readFileSync(timingPath, "utf8")) : null;
  const model = existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : null;

  const out = {
    generatedAt: new Date().toISOString(),
    report: main_.name,
    usesModel: main_.model,
    window: main_.window,
    ticks: main_.ticks,
    arrivals: main_.arrivals,
    dataLatencyS: main_.dataLatencyS,
    eta: Object.entries(main_.eta).map(([bucket, r]) => ({
      bucket, label: LABELS[bucket] ?? bucket, n: r.n,
      mtaMae: r.rawMae, mtaBias: r.rawBias, ourMae: r.adjMae, ourBias: r.adjBias, coverage: r.coverage,
    })),
    position: main_.position,
    motion: main_.motion,
    baseline: baseline
      ? { name: baseline.name, shortMedianM: baseline.position.shortMedianM, reversals: baseline.motion.reversals, steps: baseline.motion.steps }
      : null,
    learned: timing
      ? { window: timing.window, events: timing.samples?.events ?? 0, etaObs: timing.samples?.etaObs ?? 0,
          segments: Object.keys(timing.runTime ?? {}).length, stops: Object.keys(timing.dwell ?? {}).length }
      : null,
    model: model?.metrics ? { generatedAt: model.generatedAt, ...model.metrics } : null,
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT} from ${preferred}${baseline ? ` (baseline ${baseline.name})` : ""}`);
  for (const e of out.eta) console.log(`  ${e.label.padEnd(14)} n=${String(e.n).padStart(5)}  MTA ${e.mtaMae.toFixed(1)}s → ours ${e.ourMae.toFixed(1)}s  (${(e.coverage * 100).toFixed(0)}% within 1σ)`);
}

main();
