---
id: 30
uid: df1896dc-d342-4ab9-99b7-30b169a28005
title: 'Colour: one system for the railway and the interface, grounded in the MTA''s hues'
type: feature
status: done
milestone: render-4
created: 2026-11-07
updated: 2026-11-07
closed_at: 2026-11-07
priority: p1
area: front-end
effort: m
---

## Problem

The interface and the railway used two palettes.

- **The interface** used Apple's system colours: blue at hue 253, green at 147, amber at 67 and red at 26.
- **The lines** used the MTA's printed colours, at hues a few degrees away and at lightnesses from 0.40 to 0.86.

On one screen the panel and the map read as two systems.

- **Red text looked like an error message.** The interface set states as coloured words: red "delayed" figures, red "DELAYS" labels, red "% worse", amber status text.
- **Some printed colours failed on a dark screen:**
  - The 8 Avenue navy measured 2.1:1 on black, so it was drawn in a second, lighter blue.
  - White letters on the G and the L measured 2.3:1 and 2.4:1.
- **The palette lived in two places.** `network.json` carried a copy of every line colour, baked in at build time, so changing a token changed the panel and left the map as it was.

## Proposal

- **One set of ramps** (`src/lib/ramps.ts`), in OKLCH.
  - Each hue and chroma is measured from a colour the MTA prints for one trunk.
  - Each step is one lightness in every hue.
  - Only lightness is adjusted for a dark web screen.
  - The neutrals sit on the hue of the MTA's greys.
- **A generator** (`npm run build:palette`) writes the primitive layer of `tokens.css` and the canvas's copy of the palette. A test fails when either is stale.
- **Each trunk is one step of its own ramp**, in the band where a line reads on black and a white letter reads on the bullet, both at 3:1 or better. The bullet and the line are one colour.
- **The interface's colours come from the same ramps:**
  - the accent is the 8 Avenue blue;
  - good is the Lexington green;
  - a warning is the Broadway yellow;
  - a fault is the 7 Avenue red.
- **States are marks, never words.** A pip, a ring or a bar carries the colour, and the words stay in the label hierarchy. The countdown's NOW is the one exception.
- **Line colours are read from the palette at draw time.** `network.json` no longer carries them.
- **The audit enforces it all:**
  - no literal colour outside the ramps;
  - no state colour as text;
  - text at 4.5:1 and marks at 3:1 on every surface;
  - every line at 3:1 on the map's black and under its letter.

## Acceptance criteria

- [x] Every hue in `src/lib/ramps.ts` is within 1° and 0.002 chroma of the MTA colour it is measured from, and a test says so.
- [x] Every trunk token names a step of its own trunk's ramp, and every line measures at least 3:1 on black and at least 3:1 under its letter, checked by the audit.
- [x] No rule sets `--good`, `--warn` or `--bad` as a text colour, except the countdown's NOW, and the audit fails one that does.
- [x] `network.json` and `network-lite.json` carry no colour, and the map, the bullets and the poster read their colours from the palette.
- [x] `npx tsx scripts/build-palette.ts --check` passes, and `tests/palette.test.ts` fails when the generated layer is stale.
- [x] `/design` shows the ramps beside the MTA's printed colours, which step each line is drawn in, and each line's contrast.
- [x] Tests, lint, typecheck, `audit:design`, `audit:layout`, `audit:a11y` and `audit-ui` (desktop and phone) pass, and the live site is checked after the deploy.

## 2026-11-07

Line contrast, printed → drawn (on black / letter): 7 Av 5.2/4.1 → 5.6/3.7; Lexington 5.2/4.0 → 4.8/4.4; Flushing 4.1/5.1 → 4.0/5.3; 8 Av 2.1/9.8 → 4.4/4.8 (one blue now, the separate line colour is gone); 6 Av 7.1/3.0 → 5.8/3.6; Broadway 13.8/13.8 → 14.1/14.1; Crosstown 9.1/2.3 → 6.6/3.2; Nassau 4.3/4.9 → 4.4/4.7; Canarsie 8.9/2.4 → 5.8/3.7; Shuttle 5.4/3.9 → 4.2/5.0; SIR 4.5/4.7 → 6.3/3.4. The stripped network files are byte-identical to a JS re-serialisation of the old ones minus the three colour fields, so no geometry changed and the GTFS was not re-fetched.

## 2026-11-07

Deployed as traintime-site f4d30f6a. Live: network-lite.json carries no colour fields; poster.svg strokes the 8 Av in #336dde; the page resolves --trunk-8av #336dde, --accent #71a3ff, --bad #f53d35, --warn #e5b800, and bullets render in the new steps. The poller does not read line colours, so it was not redeployed.
