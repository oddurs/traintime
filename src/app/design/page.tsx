"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Network } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { asset, BASE_PATH } from "@/lib/basePath";
import { TRUNKS } from "@/lib/trunks";
import {
  Button, Card, Chip, Disclosure, Field, Icon, IconButton, Inline, List, MapButton, Meter, Notice, Row, Section,
  Segmented, Select, Stack, Switch, Text, type IconName, type TextVariant,
} from "@/components/ui";
import { BulletGroup, Countdown, DirectionHeading, RouteBullet, ServiceStatus, StationName, TrunkStripe } from "@/components/brand";
import { HUES, STEPS, oklch, toOklch } from "@/lib/ramps";

/**
 * The design system, documented by rendering it.
 *
 * A design system that can only be read as source is a set of intentions. This page draws every
 * role, token and component from the same stylesheet the app uses, and the figures on it — the
 * size a role renders at, the contrast of a label on a surface — are measured in the browser
 * rather than typed in, so the page cannot disagree with the system it documents.
 * scripts/audit-design.ts enforces the rules; this page is for the judgements the rules cannot make.
 */

const ROLES: { variant: TextVariant; token: string; use: string; sample: string }[] = [
  { variant: "display", token: "t-display", use: "A document's title", sample: "How accurate is this?" },
  { variant: "title", token: "t-title", use: "A station, a train, a view's heading", sample: "14 St–Union Sq" },
  { variant: "section", token: "t-section", use: "The header over a group", sample: "Nearby" },
  { variant: "figure", token: "t-figure", use: "A number read before its label", sample: "271" },
  { variant: "headline", token: "t-headline", use: "A row's own words: a destination", sample: "Pelham Bay Park" },
  { variant: "body", token: "t-body", use: "A field, a line of interface text", sample: "Search stations" },
  { variant: "prose", token: "t-prose", use: "Paragraphs", sample: "Trains are running with delays." },
  { variant: "subhead", token: "t-subhead", use: "Context under a headline; controls; notices", sample: "Northbound · 2 stops away" },
  { variant: "footnote", token: "t-footnote", use: "Fine print, a label under a figure", sample: "alerts just now" },
  { variant: "micro", token: "t-micro", use: "Words in capitals: a unit, a direction", sample: "Northbound" },
  { variant: "code", token: "t-code", use: "A train id, an endpoint", sample: "GET /v1/lines" },
];

const NEUTRALS = ["gray-1000", "gray-950", "gray-900", "gray-850", "gray-700", "gray-600", "gray-500", "gray-400", "gray-300", "gray-50", "white"];
const ALPHAS = ["white-a06", "white-a08", "white-a11", "white-a16", "white-a35", "black-a50", "black-a60"];
const SURFACES = ["ground", "surface-solid", "surface-sunken", "fill", "fill-2", "fill-3", "separator", "edge"];
const LABELS = ["label", "label-2", "label-3", "accent", "good"];
const MARKS = ["accent-ground", "good", "warn", "bad"];
const CONTRAST_ON: { name: string; over?: string }[] = [
  { name: "ground" }, { name: "surface-solid" }, { name: "fill", over: "surface-solid" }, { name: "fill-2", over: "surface-solid" },
];
const SPACE = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
const RADII = ["r-inner", "r-control", "r-card", "r-sheet", "r-panel"];
const SHADOWS = ["shadow-1", "shadow-2", "shadow-3"];
const LAYERS: [string, string][] = [
  ["z-pip", "a mark at the corner of a bullet"],
  ["z-controls", "the buttons that float over the map"],
  ["z-panel", "the card"],
  ["z-popover", "search results, over the card's own contents"],
];
const MOTION: [string, string][] = [
  ["fast", "a press, a hover, a chevron turning"],
  ["slow", "the card moving between stops, the map fading in"],
  ["ambient", "a loop meant to be ignored: a shimmer, a breathing dot"],
];
const ICONS: IconName[] = ["magnifyingglass", "xmark", "star", "star.fill", "location", "location.fill", "chevron.right", "chevron.up", "chevron.down", "plus", "clock", "exclamationmark"];

/* ---- Measuring the system in the browser, so the page cannot drift from it. ---- */

type RGBA = [number, number, number, number];
/** A colour as the browser resolved it: rgb(), rgba(), or color(srgb …) for a color-mix(). */
function parseColour(v: string): RGBA | null {
  let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(v);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
  return null;
}
function resolved(token: string): RGBA | null {
  const probe = document.createElement("i");
  probe.style.color = `var(--${token})`;
  document.body.append(probe);
  const c = parseColour(getComputedStyle(probe).color);
  probe.remove();
  return c;
}
const over = (t: RGBA, u: RGBA): RGBA => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
const lum = (c: RGBA) => {
  const ch = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The size and leading a role renders at, read from the element itself. */
function Measured({ variant, sample }: { variant: TextVariant; sample: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [m, setM] = useState("");
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild;
    if (!el) return;
    const cs = getComputedStyle(el);
    setM(`${parseFloat(cs.fontSize)} / ${parseFloat(cs.lineHeight) || "—"} · ${cs.fontWeight}`);
  }, []);
  return (
    <>
      <td><span ref={ref}><Text variant={variant} caps={variant === "micro"}>{sample}</Text></span></td>
      <td className="num">{m}</td>
    </>
  );
}

function ContrastTable() {
  const [rows, setRows] = useState<{ label: string; cells: number[] }[] | null>(null);
  useEffect(() => {
    const surfaces = CONTRAST_ON.map((s) => {
      const top = resolved(s.name);
      const under = s.over ? resolved(s.over) : null;
      return top && under ? over(top, under) : top;
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measured from the live stylesheet, which render cannot read
    setRows(LABELS.map((l) => {
      const c = resolved(l);
      return { label: l, cells: surfaces.map((s) => (c && s ? ratio(over(c, s), s) : 0)) };
    }));
  }, []);
  if (!rows) return null;
  return (
    <table>
      <thead><tr><th>text</th>{CONTRAST_ON.map((s) => <th key={s.name} className="num">on --{s.name}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td><code>--{r.label}</code></td>
            {r.cells.map((c, i) => <td key={i} className={`num${c >= 4.5 ? " win" : " stale"}`}>{c.toFixed(2)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every ramp, every step, with the MTA's printed colour beside it and the step each trunk is drawn
 * in marked. Computed from src/lib/ramps.ts, the same numbers that generate the tokens.
 */
function Ramps() {
  const steps = Object.entries(STEPS);
  return (
    <table>
      <thead><tr><th>ramp</th><th>printed</th>{steps.map(([s]) => <th key={s} className="num">{s}</th>)}</tr></thead>
      <tbody>
        {Object.entries(HUES).map(([name, hue]) => {
          const used = Object.values(TRUNKS).find((t) => t.name === hue.from);
          return (
            <tr key={name}>
              <td><Stack gap={0}><Text variant="subhead">{name}</Text><Text variant="footnote" tone="tertiary">{hue.from}, L {toOklch(hue.printed)[0].toFixed(2)}</Text></Stack></td>
              <td><i className="ds-chip ds-chip--sm" style={{ ["--ds-fill" as string]: hue.printed }} /></td>
              {steps.map(([s, L]) => (
                <td key={s}>
                  <i className={`ds-chip ds-chip--sm${used && tokenStep(used.token) === `${name}-${s}` ? " ds-chip--picked" : ""}`} style={{ ["--ds-fill" as string]: oklch(L, hue.c, hue.h) }} />
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Which ramp step a token names, read from the live stylesheet's source of truth: tokens.css as served. */
function tokenStep(token: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ":root") continue;
      const m = /var\(--([a-z]+-\d+)\)/.exec(rule.style.getPropertyValue(token));
      if (m) return m[1];
    }
  }
  return undefined;
}

/** Each line, as printed and as drawn, and what it measures on the map and under its letter. */
function LineTable() {
  const [rows, setRows] = useState<{ id: string; name: string; on: number; ink: number }[] | null>(null);
  useEffect(() => {
    const black = resolved("map-casing");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measured from the live stylesheet, which render cannot read
    setRows(Object.entries(TRUNKS).map(([id, t]) => {
      const c = resolved(t.token.slice(2)), ink = resolved(t.ink === "dark" ? "ink-dark" : "ink-light");
      return { id, name: t.name, on: c && black ? ratio(c, black) : 0, ink: c && ink ? ratio(ink, c) : 0 };
    }));
  }, []);
  if (!rows) return null;
  return (
    <table>
      <thead><tr><th>line</th><th>drawn as</th><th className="num">on black</th><th className="num">letter</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td><code>{tokenStep(`--trunk-${r.id}`) ?? "—"}</code></td>
            <td className={`num${r.on >= 3 ? " win" : " stale"}`}>{r.on.toFixed(1)}</td>
            <td className={`num${r.ink >= 3 ? " win" : " stale"}`}>{r.ink.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Swatches({ tokens, tall }: { tokens: string[]; tall?: boolean }) {
  return (
    <div className="ds-swatches">
      {tokens.map((t) => (
        <div className="ds-swatch" key={t}>
          <i className={tall ? "ds-chip ds-chip--tall" : "ds-chip"} style={{ ["--ds-fill" as string]: `var(--${t})` }} />
          <code>--{t}</code>
        </div>
      ))}
    </div>
  );
}

export default function DesignPage() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);
  const [on, setOn] = useState(true);
  const [q, setQ] = useState("");
  const [speed, setSpeed] = useState(10);
  const [radius, setRadius] = useState<5 | 10 | 20>(10);
  const [open, setOpen] = useState<string | null>("delays");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(asset("/data/network-lite.json")).then((r) => r.json()).then((n: Network) => setIndex(new NetworkIndex(n))).catch((e: unknown) => console.error(e));
  }, []);

  return (
    <main className="doc ds">
      <a className="back" href={`${BASE_PATH}/`}>← the map</a>
      <header>
        <h1>The system</h1>
        <p>
          Two voices, kept apart on purpose. The <b>railway</b> is set the way the MTA sets it:
          Helvetica, trunk colours, roundels, the countdown. The <b>application</b> is set the way
          the platform sets it: the system face, fills instead of borders, a small vocabulary of
          controls. Signage where the subject is the subway; interface where the subject is the app.
        </p>
      </header>

      <h2>How it is built</h2>
      <p>
        Four layers, each using only the ones above it. <b>Tokens</b> are the values, in{" "}
        <code>src/app/tokens.css</code>. <b>Primitives</b> — <code>Stack</code>, <code>Inline</code>,{" "}
        <code>Text</code> — are layout with no appearance of their own. <b>Components</b> in{" "}
        <code>src/components/ui</code> are the controls. <b>Features</b> such as the station board are
        made of components and add no styling of their own beyond arrangement.
      </p>
      <p>
        The tokens come in three layers. <b>Primitives</b> are named for what they are —{" "}
        <code>--gray-400</code>, <code>--fs-17</code> — and nothing outside the token file may use one.{" "}
        <b>Semantic</b> tokens are named for what they are for — <code>--label-2</code>,{" "}
        <code>--t-headline</code> — and each names a primitive. <b>Data</b> is the railway&rsquo;s own
        colours, which are facts about New York rather than decisions. A theme is one edit to the
        semantic layer.
      </p>

      <h2>Type</h2>
      <p>
        One scale on every device, on Apple&rsquo;s text sizes: 12, 13, 15, 17, 20, 22, 28 and 34
        pixels at the reader&rsquo;s default of 16 to the rem. Twelve roles sit on those eight
        sizes, with three weights. A role is a whole font and carries its own tracking. Nothing is
        set under 12 pixels, and the audit fails the build if a role ever is.
      </p>
      <p>
        The interface used to render at 81 % of these sizes. The root element had been given the
        body&rsquo;s font, which made every rem 13 pixels, so a 12-pixel label drew at 9.75. The
        root now keeps the browser&rsquo;s size and only the body is set.
      </p>
      <table>
        <thead><tr><th>role</th><th>sample</th><th className="num">size / leading · weight</th><th>for</th></tr></thead>
        <tbody>
          {ROLES.map((r) => (
            <tr key={r.variant}>
              <td><code>--{r.token}</code></td>
              <Measured variant={r.variant} sample={r.sample} />
              <td>{r.use}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Section title="In use">
        <Stack gap={1}>
          <Text variant="title" as="h3">14 St–Union Sq</Text>
          <Text variant="subhead" tone="secondary">3 min walk · 210 m</Text>
        </Stack>
        <Inline gap={3} justify="between">
          <Stack gap={0}>
            <Text variant="headline">Pelham Bay Park</Text>
            <Text variant="subhead" tone="secondary">Northbound · 2 stops away</Text>
          </Stack>
          <Countdown seconds={240} here={false} />
        </Inline>
      </Section>

      <h2>Colour</h2>
      <p>
        One system for the railway and the interface. Every colour is a step on a ramp, and every
        ramp takes its hue and chroma from a colour the MTA prints for one of its trunk lines. What
        is adjusted for a dark web screen is lightness alone, in OKLCH, where equal lightness looks
        equally light in any hue. A step of 500 is as bright in blue as in orange. The red of the
        1 train and the red of a delay are one red.
      </p>
      <p>
        The interface takes its colours from the same ramps. The accent is the 8 Avenue blue, a good
        state the Lexington green, a warning the Broadway yellow, a fault the 7 Avenue red. They used
        to be Apple&rsquo;s system colours, a few degrees from the lines beside them.
      </p>
      <Section title="The ramps, against what the MTA prints">
        <p>The outlined step is the one each line is drawn in.</p>
        <Ramps />
      </Section>
      <Section title="The lines on a dark screen">
        <p>
          Each line sits where a two-pixel stroke reads on black and a white letter reads on the
          bullet, both at 3:1 or better. 8 Avenue moves furthest: its printed navy measures 2.1:1 on
          black, so it is drawn lighter, and the bullet and the line are now one blue. The Crosstown
          green and the L&rsquo;s grey are drawn darker, because white letters on the printed colours
          measured 2.3 and 2.4.
        </p>
        <LineTable />
      </Section>
      <Section title="Neutrals, on the MTA's grey"><Swatches tokens={NEUTRALS} /></Section>
      <Section title="Light and shade"><Swatches tokens={ALPHAS} /></Section>
      <Section title="Surfaces and fills"><Swatches tokens={SURFACES} /></Section>
      <Section title="Text"><Swatches tokens={LABELS} tall /></Section>
      <Section title="Marks"><Swatches tokens={MARKS} /></Section>
      <p>
        A state is a mark, never words: a pip, a ring, a bar or the edge of a card carries the colour,
        and the words beside it stay in the label hierarchy. Red text on a dark ground reads as an
        error message whatever it says. The only state ever set as words is the countdown&rsquo;s NOW,
        the platform sign&rsquo;s own word. Text holds 4.5:1 on every surface, measured here:
      </p>
      <ContrastTable />

      <h2>Space, shape, depth</h2>
      <Section title="The 8-point grid">
        <Stack gap={2}>
          {SPACE.map((t) => (
            <div className="ds-space" key={t}>
              <i style={{ ["--ds-size" as string]: `var(--${t})` }} />
              <code>--{t}</code>
            </div>
          ))}
        </Stack>
      </Section>
      <Section title="Radii">
        <Inline gap={4} wrap>
          {RADII.map((t) => (
            <div className="ds-cell" key={t}>
              <i className="ds-radius" style={{ ["--ds-radius" as string]: `var(--${t})` }} />
              <code>--{t}</code>
            </div>
          ))}
        </Inline>
      </Section>
      <Section title="Elevation">
        <Inline gap={5} wrap>
          {SHADOWS.map((t) => (
            <div className="ds-cell" key={t}>
              <i className="ds-radius ds-shadow" style={{ ["--ds-shadow" as string]: `var(--${t})` }} />
              <code>--{t}</code>
            </div>
          ))}
        </Inline>
      </Section>
      <Section title="Layers">
        <table>
          <tbody>{LAYERS.map(([t, d]) => <tr key={t}><td><code>--{t}</code></td><td>{d}</td></tr>)}</tbody>
        </table>
      </Section>
      <Section title="Motion">
        <p>One curve, <code>--ease</code>, and three durations. With reduced motion asked for, every duration drops to nothing.</p>
        <table>
          <tbody>{MOTION.map(([t, d]) => <tr key={t}><td><code>--{t}</code></td><td>{d}</td></tr>)}</tbody>
        </table>
      </Section>
      <Section title="Breakpoint">
        <p>
          One: <code>--bp-phone</code>, 640 pixels. Under it the card becomes a sheet that swipes up
          from the bottom. A media query cannot read a custom property, so the audit checks that
          every query and the first-paint script say the same number.
        </p>
      </Section>

      <h2>Primitives</h2>
      <p>
        <code>Stack</code> is a column and <code>Inline</code> a row, with a gap that is a step of
        the grid by number — never a length. <code>Text</code> sets one role, in one tone, on
        whichever element is right for it. None of them has a margin: spacing belongs to whatever
        holds them.
      </p>
      <div className="ds-panel">
        <Stack gap={3}>
          <Inline justify="between">
            <Text variant="section" as="h3">Lines</Text>
            <Button variant="ghost">Show all</Button>
          </Inline>
          <Inline gap={5}>
            {([["271", "trains", undefined], ["4", "held", "warn"], ["1", "delayed", "bad"]] as const).map(([v, l, t]) => (
              <Stack gap={0} key={l}>
                <Text variant="figure">{v}</Text>
                <Inline gap={1}>
                  {t && <i className={`stat-mark stat-mark--${t}`} aria-hidden="true" />}
                  <Text variant="footnote" tone="tertiary">{l}</Text>
                </Inline>
              </Stack>
            ))}
          </Inline>
          <Text variant="micro" tone="tertiary" caps>Tones</Text>
          <Inline gap={3} wrap>
            {(["primary", "secondary", "tertiary", "accent"] as const).map((t) => (
              <Text key={t} variant="subhead" tone={t}>{t}</Text>
            ))}
          </Inline>
        </Stack>
      </div>

      <h2>Controls</h2>
      <p>Four weights of emphasis, and no fifth: a button that needed to look different from these would be a hole in the system.</p>
      <Inline gap={3} wrap>
        <Button>plain</Button>
        <Button variant="tinted" icon="plus">tinted</Button>
        <Button variant="filled">filled</Button>
        <Button variant="ghost">ghost</Button>
        <Button disabled>disabled</Button>
        <Button variant="ghost" on>selected</Button>
      </Inline>
      <Inline gap={3} wrap>
        <Segmented ariaLabel="Walking distance" value={radius} onChange={setRadius}
          options={[{ value: 5, label: "5 min" }, { value: 10, label: "10 min" }, { value: 20, label: "20 min" }]} />
        <Switch checked={on} onChange={setOn}>a switch, not a checkbox</Switch>
        <Select value={speed} onChange={setSpeed} parse={Number} ariaLabel="Speed"
          options={[1, 5, 10, 30].map((s) => ({ value: s, label: `${s}×` }))} />
      </Inline>
      <Inline gap={3} wrap>
        <IconButton icon="star" ariaLabel="Save" />
        <IconButton icon="star.fill" on ariaLabel="Saved" />
        <IconButton icon="xmark" ariaLabel="Close" />
        <MapButton icon="location" onClick={() => {}} ariaLabel="Show trains near me" />
        <MapButton icon="location.fill" on onClick={() => {}} ariaLabel="Stop using my location" />
        <Chip tone="live">Live</Chip>
        <Chip tone="replay">Replay 10×</Chip>
        <Chip>Plain</Chip>
      </Inline>

      <h2>Icons</h2>
      <p>Drawn on a 16-unit grid at one stroke weight, so an icon and the words beside it read as one voice.</p>
      <Inline gap={4} wrap>
        {ICONS.map((n) => (
          <div className="ds-cell" key={n}><Icon name={n} size="lg" /><code>{n}</code></div>
        ))}
      </Inline>

      <h2>Fields, rows and groups</h2>
      <div className="ds-panel">
        <Field value={q} onChange={setQ} placeholder="Search stations" ariaLabel="Search" icon="magnifyingglass"
          accessory={q ? <IconButton icon="xmark" ariaLabel="Clear search" onClick={() => setQ("")} /> : undefined} />
        {index && (
          <Section title="Northbound">
            <DirectionHeading direction="Northbound" toward="Woodlawn" />
            <List leading>
              <Row
                leading={<RouteBullet index={index} route="4" size="lg" />}
                title="Woodlawn" subtitle="next stop · ± 2 min"
                trailing={<Countdown seconds={70} here={false} />}
              />
              <Row
                leading={<RouteBullet index={index} route="5" size="lg" />}
                title="Eastchester–Dyre Av" subtitle="at the platform"
                trailing={<Countdown seconds={0} here />}
              />
              <Row title="Lines on the map" subtitle="All shown" expanded={expanded} onClick={() => setExpanded((e) => !e)} />
            </List>
          </Section>
        )}
      </div>

      <h2>Status and disclosure</h2>
      <div className="ds-panel">
        <Notice tone="ok">879 trains · feed just now</Notice>
        <Notice tone="warn">feed down: ace</Notice>
        <Notice tone="bad" action={<Button variant="ghost">Try again</Button>}>Couldn’t load the stations.</Notice>
        <Card>
          <StationName as="h3">14 St–Union Sq</StationName>
          {index && <BulletGroup index={index} routes={["L", "N", "Q", "R", "W", "4", "5", "6", "6X"]} size="md" />}
        </Card>
        <Meter value={0.62} ariaLabel="62%" />
        <Disclosure tone="delay" lead="Delays" summary="Northbound trains are running with delays." open={open === "delays"} onToggle={() => setOpen(open === "delays" ? null : "delays")}>
          We are holding trains while we address a signal problem.
        </Disclosure>
      </div>

      <h2>The railway</h2>
      <Section title="Trunk lines">
        <p>
          The subway is organised by trunk, not by service: the 1, 2 and 3 are three services on one
          red line, and a service takes its colour from its trunk. These are the colours the MTA
          prints. Only 8 Avenue is lifted for the map, from <code>#0039a6</code> to{" "}
          <code>#0053f3</code>, because the printed blue measures 2.14:1 on black; its bullet keeps
          the printed colour. The ink is the agency&rsquo;s everywhere: only the Broadway yellow is
          set in black, because a G with a black letter on it is not a G anyone in New York has seen.
        </p>
        <Stack gap={2}>
          {index && Object.keys(TRUNKS).map((id) => (
            <TrunkStripe key={id} id={id}>
              <BulletGroup index={index} routes={TRUNKS[id].services} size="md" />
            </TrunkStripe>
          ))}
        </Stack>
      </Section>
      <Section title="Roundels">
        <p>
          A circle for a local and a diamond for an express, drawn from one specification and
          rendered twice: as SVG here, and into the map&rsquo;s atlas for the trains. Size is a name.
        </p>
        {index && (
          <Inline gap={5} wrap>
            {(["sm", "md", "lg", "xl"] as const).map((size) => (
              <div className="ds-cell" key={size}>
                <Inline gap={2}>
                  <RouteBullet index={index} route="1" size={size} />
                  <RouteBullet index={index} route="6X" size={size} />
                  <RouteBullet index={index} route="SI" size={size} />
                </Inline>
                <code>{size}</code>
              </div>
            ))}
            <div className="ds-cell">
              <Inline gap={2}>
                <RouteBullet index={index} route="A" size="xl" dim />
                <RouteBullet index={index} route="F" size="xl"><span className="alert-pip delay" /></RouteBullet>
              </Inline>
              <code>dim · alert</code>
            </div>
          </Inline>
        )}
      </Section>
      <Section title="How a line is running">
        <p>The agency publishes four states and a rider reads them off signs all day. There is no fifth.</p>
        <Stack gap={2}>
          {(["good", "delay", "planned", "info"] as const).map((s) => <ServiceStatus key={s} status={s} />)}
        </Stack>
      </Section>
      <Section title="The countdown">
        <p>
          The signature element, and the one fluid role: it measures the panel holding it rather than
          the window, from 28 pixels in a narrow card to 34 across a phone.
        </p>
        <Inline gap={5} wrap>
          <div className="ds-cell"><Countdown seconds={480} here={false} /><code>minutes</code></div>
          <div className="ds-cell"><Countdown seconds={10} here /><code>at the platform</code></div>
          <div className="ds-cell"><Countdown seconds={10} here departing /><code>leaving</code></div>
          <div className="ds-cell"><Countdown seconds={200} here={false} missed /><code>out of reach</code></div>
          <div className="ds-cell"><Countdown seconds={200} here={false} compact /><code>compact</code></div>
        </Inline>
      </Section>

      <h2>Rules</h2>
      <ol>
        <li><b>Rule of three.</b> A pattern becomes a component the third time it appears. The first is a one-off; the second is a coincidence.</li>
        <li><b>A new component needs a real use.</b> No dialog, menu or toast exists yet because nothing in the app needs one; when something does, its behaviour comes from a headless library, not from here.</li>
        <li><b>Changing a token is a system change.</b> Adding one is cheap. Changing one moves the whole product, which is the point, and it should be deliberate.</li>
        <li><b>The audit is the gate.</b> <code>npm run audit:design</code> fails on a hand-written value, a primitive used outside the token file, a weight, layer or leading that is not a token, a role under 12 pixels, a second breakpoint, a label under 4.5:1, and a token nothing uses.</li>
      </ol>
    </main>
  );
}
