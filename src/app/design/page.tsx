"use client";

import { useEffect, useState } from "react";
import type { Network } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { asset, BASE_PATH } from "@/lib/basePath";
import { TRUNKS } from "@/lib/trunks";
import {
  Button, Card, Chip, Disclosure, Field, Icon, IconButton, List, Meter, Notice, Row, Section,
  Select, Switch, type IconName,
} from "@/components/ui";
import { BulletGroup, Countdown, DirectionHeading, RouteBullet, ServiceStatus, StationName, TrunkStripe } from "@/components/brand";

/**
 * The component library, drawn.
 *
 * A design system that can only be read as source is a set of intentions. This is the same system
 * rendered — every token, every control, every state — so that a divergence is something you can
 * see rather than something you have to infer. scripts/audit-design.ts checks the rules; this page
 * is for the judgements the rules cannot make, like whether the tertiary label is still legible on
 * the panel material or whether two greys are doing the same job.
 */

const TYPE: { token: string; role: string }[] = [
  { token: "t-clock", role: "the countdown — the one fluid step, measured against the panel" },
  { token: "t-large", role: "a document's title" },
  { token: "t-title", role: "a station, a view's heading" },
  { token: "t-headline", role: "a destination, a row's own words" },
  { token: "t-body", role: "prose, a field, a list row" },
  { token: "t-caption", role: "context, status, most controls" },
  { token: "t-micro", role: "units and section headings, set in capitals" },
  { token: "t-code", role: "a train id, an endpoint, a payload" },
];

const SURFACES = ["ground", "surface-solid", "surface-sunken", "fill", "fill-2", "fill-3", "separator", "edge", "edge-strong"];
const LABELS = ["label", "label-2", "label-3", "on-accent"];
const ACCENTS = ["accent", "accent-hover", "accent-fill", "green", "amber", "red", "glow"];
const SPACE = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
const RADII = ["r-inner", "r-chip", "r-card", "r-panel", "r-sheet"];
const ICONS: IconName[] = ["magnifyingglass", "xmark", "star", "star.fill", "location", "chevron.right", "chevron.up", "chevron.down", "plus", "clock", "exclamationmark"];

function Swatches({ title, tokens, tall }: { title: string; tokens: string[]; tall?: boolean }) {
  return (
    <Section title={title}>
      <div className="ds-swatches">
        {tokens.map((t) => (
          <div className="ds-swatch" key={t}>
            <i className={tall ? "ds-chip ds-chip--tall" : "ds-chip"} style={{ ["--ds-fill" as string]: `var(--${t})` }} />
            <code>--{t}</code>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function DesignPage() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);
  const [on, setOn] = useState(true);
  const [q, setQ] = useState("");
  const [speed, setSpeed] = useState(10);
  const [open, setOpen] = useState<string | null>("delays");

  useEffect(() => {
    fetch(asset("/data/network-lite.json")).then((r) => r.json()).then((n: Network) => setIndex(new NetworkIndex(n))).catch(() => {});
  }, []);

  return (
    <main className="doc ds">
      <a className="back" href={`${BASE_PATH}/`}>← the map</a>
      <header>
        <h1>The system</h1>
        <p>
          Two systems, kept apart on purpose. The <b>brand</b> layer follows the MTA — trunk colours,
          roundels, the countdown, the words for how a line is running. The <b>interface</b> layer
          follows the platform — buttons, fields, rows, switches. Signage where the subject is the
          railway; interface where the subject is the application.
        </p>
      </header>

      <h2>Trunk lines</h2>
      <p>
        The subway is organised by trunk, not by service: the 1, 2 and 3 are three services on one
        red line. A service takes its colour from its trunk, and the map collapses a trunk to a
        single line once you are too far away to tell its services apart. These are the colours the
        MTA prints.
      </p>
      <p>
        An emblem and a line have different jobs. Ten of the eleven trunks clear 4:1 against the
        map&rsquo;s black ground and read at a two-pixel stroke; 8 Avenue does not, so its line is
        lifted from <code>#0039a6</code> to <code>#0053f3</code> — hue and saturation untouched —
        while the bullet keeps the printed colour.
      </p>
      <p>
        The ink is the agency&rsquo;s everywhere, and only the Broadway yellow is set in black.
        White on the crosstown green measures 2.3:1 and on the Canarsie grey 2.4:1, and for a while
        those three trunks were given black on that evidence. The measurement was right and the
        conclusion was wrong: these are the bullets from the platform signs, and a G with a black
        character on it is not a hard-to-read G, it is one nobody in New York has ever seen. Where
        legibility and fidelity disagree the sign wins, and the answer to a dim bullet is its size.
      </p>
      <div className="ds-stack">
        {index && Object.keys(TRUNKS).map((id) => (
          <TrunkStripe key={id} id={id}>
            <BulletGroup index={index} routes={TRUNKS[id].services} size="md" />
          </TrunkStripe>
        ))}
      </div>

      <h2>Roundels</h2>
      <p>
        A circle for a local service and a diamond for an express, drawn from one specification —
        the same path, the same Helvetica, the same casing — and rendered two ways: as SVG here, and
        rasterised into the map&rsquo;s image atlas for the trains. A bullet in the panel and the
        marker for that train on the map are one emblem rather than two drawings meant to look
        alike. The capital is centred on the shape rather than its em box, which is what stops a
        numeral riding high. Size is a name, not a number.
      </p>
      {index && (
        <div className="ds-row">
          {(["sm", "md", "lg", "xl"] as const).map((size) => (
            <div className="ds-cell" key={size}>
              <div className="ds-row">
                <RouteBullet index={index} route="1" size={size} />
                <RouteBullet index={index} route="6X" size={size} />
                <RouteBullet index={index} route="SI" size={size} />
              </div>
              <code>{size}</code>
            </div>
          ))}
          <div className="ds-cell">
            <div className="ds-row">
              <RouteBullet index={index} route="A" size="xl" dim />
              <RouteBullet index={index} route="F" size="xl"><span className="alert-pip delay" /></RouteBullet>
            </div>
            <code>dim · alert</code>
          </div>
        </div>
      )}

      <h2>How a line is running</h2>
      <p>The agency publishes four states and a rider reads them off signs all day. There is no fifth.</p>
      <div className="ds-stack">
        {(["good", "delay", "planned", "info"] as const).map((s) => <ServiceStatus key={s} status={s} />)}
      </div>

      <h2>The countdown</h2>
      <p>
        This application&rsquo;s signature element, and the only fluid type in the system: it measures
        the panel holding it rather than the window, so it grows on a phone sheet and holds still in
        a desktop side panel.
      </p>
      <div className="ds-row ds-row--wide">
        <div className="ds-cell"><Countdown seconds={480} here={false} /><code>minutes</code></div>
        <div className="ds-cell"><Countdown seconds={10} here /><code>at the platform</code></div>
        <div className="ds-cell"><Countdown seconds={10} here departing /><code>leaving</code></div>
        <div className="ds-cell"><Countdown seconds={200} here={false} missed /><code>out of reach on foot</code></div>
      </div>

      <h2>Type</h2>
      <p>
        Signage is Helvetica, the face every station is signed in; interface is whatever the platform
        calls its own. Each step carries its own tracking and the two are never separated.
      </p>
      <div className="ds-stack">
        {TYPE.map((t) => (
          <div className="ds-type" key={t.token}>
            <b style={{ ["--t-sample" as string]: `var(--${t.token})`, ["--tr-sample" as string]: `var(--tr-${t.token.slice(2)})` }}>14 St–Union Sq</b>
            <code>--{t.token}</code>
            <em>{t.role}</em>
          </div>
        ))}
      </div>

      <h2>Colour</h2>
      <Swatches title="Surfaces and fills" tokens={SURFACES} />
      <Swatches title="Labels" tokens={LABELS} tall />
      <Swatches title="Accents" tokens={ACCENTS} />

      <h2>Space and shape</h2>
      <Section title="The eight-point grid">
        <div className="ds-stack">
          {SPACE.map((t) => (
            <div className="ds-space" key={t}>
              <i style={{ ["--ds-size" as string]: `var(--${t})` }} />
              <code>--{t}</code>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Radii">
        <div className="ds-row">
          {RADII.map((t) => (
            <div className="ds-cell" key={t}>
              <i className="ds-radius" style={{ ["--ds-radius" as string]: `var(--${t})` }} />
              <code>--{t}</code>
            </div>
          ))}
        </div>
      </Section>

      <h2>Controls</h2>
      <p>Four weights of emphasis, and no fifth: a button that needed to look different from these would be a hole in the system.</p>
      <div className="ds-row ds-row--wide">
        <Button>plain</Button>
        <Button variant="tinted" icon="plus">tinted</Button>
        <Button variant="filled">filled</Button>
        <Button variant="ghost">ghost</Button>
        <Button disabled>disabled</Button>
        <Button variant="ghost" on>selected</Button>
      </div>
      <div className="ds-row ds-row--wide">
        <IconButton icon="star" ariaLabel="Save" />
        <IconButton icon="star.fill" on ariaLabel="Saved" />
        <IconButton icon="xmark" ariaLabel="Close" />
        <Switch checked={on} onChange={setOn}>a switch, not a checkbox</Switch>
        <Select value={speed} onChange={setSpeed} parse={Number} ariaLabel="Speed"
          options={[1, 5, 10, 30].map((s) => ({ value: s, label: `${s}×` }))} />
        <Chip tone="live">Live</Chip>
        <Chip tone="replay">Replay 10×</Chip>
        <Chip>Plain</Chip>
      </div>

      <h2>Icons</h2>
      <p>Drawn on a 16-unit grid at one stroke weight, so an icon and the words beside it read as the same voice — not borrowed from the font.</p>
      <div className="ds-row ds-row--wide">
        {ICONS.map((n) => (
          <div className="ds-cell" key={n}><Icon name={n} size="lg" /><code>{n}</code></div>
        ))}
      </div>

      <h2>Fields</h2>
      <div className="ds-panel">
        <Field value={q} onChange={setQ} placeholder="Search stations…" ariaLabel="Search" icon="magnifyingglass"
          accessory={<Button variant="ghost" icon="location">near me</Button>} />
      </div>

      <h2>Rows and lists</h2>
      <p>One inset grouped list, two insets: separators stop short of the leading edge so the group reads as a single object.</p>
      {index && (
        <div className="ds-panel">
          <DirectionHeading direction="Northbound" toward="Woodlawn" />
          <List leading>
            <Row
              leading={<RouteBullet index={index} route="4" size="lg" />}
              title="Woodlawn" subtitle="next stop · give or take 26 s"
              trailing={<Countdown seconds={70} here={false} />}
            />
            <Row
              leading={<RouteBullet index={index} route="5" size="lg" />}
              title="Eastchester–Dyre Av" subtitle="at the platform"
              trailing={<Countdown seconds={0} here />}
            />
          </List>
          <List>
            <Row leading={<span className="notice-pip pip--delay" />} title="2 service changes" disclosure />
          </List>
        </div>
      )}

      <h2>Status, cards and disclosure</h2>
      <div className="ds-panel">
        <Notice tone="ok">879 trains · feed just now</Notice>
        <Notice tone="warn">feed down: ace</Notice>
        <Notice tone="bad">not connected</Notice>
        <Card>
          <StationName as="h3">14 St–Union Sq</StationName>
          {index && <BulletGroup index={index} routes={["L", "N", "Q", "R", "W", "4", "5", "6", "6X"]} size="md" />}
        </Card>
        <Meter value={0.62} ariaLabel="62%" />
        <Disclosure tone="delay" lead="Delays" summary="Northbound trains are running with delays." open={open === "delays"} onToggle={() => setOpen(open === "delays" ? null : "delays")}>
          We are holding trains while we address a signal problem.
        </Disclosure>
      </div>
    </main>
  );
}
