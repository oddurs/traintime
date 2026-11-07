---
id: 29
uid: b4dd0bc8-8dfb-4e37-b047-be0057594fea
title: 'Design system: a type scale that renders at its size, and two token layers'
type: feature
status: done
milestone: render-4
created: 2026-11-07
updated: 2026-11-07
closed_at: 2026-11-07
priority: p1
area: front-end
effort: l
---

## Problem

The type is too small to read. Measured on the live desktop panel:

| Text | Meant to be | Rendered |
|---|---|---|
| Counts under the bullets, the badge | 11 px | 8.9 px |
| Row subtitles, buttons, hints | 12 px | 9.75 px |
| Row titles | 14 px | 11.4 px |
| Section headers | 15 px | 12.2 px |

There are two causes.

1. **A bug.** `html, body { font: var(--t-body) }` sets the root font size to 0.8125rem, which is 13 px. Every `rem` in the scale then resolves against 13 px instead of 16 px, so the whole interface renders at 81 % of its design size. On a touch screen the body token is 0.9375rem, so there it renders at 94 %.
2. **The scale itself.** It followed the macOS sizes (13-point body, 11-point micro). A web page at desktop distance reads at about 16–17 px.

`--t-code` still refers to `--type-scale`, which no longer exists, so its font shorthand is invalid and code falls back to the inherited style.

The token layer is one flat list. Semantic tokens (`--label-2`) hold literal colours, so a theme would be an edit to every colour. Radii have seven names for five values. `z-index` and `font-weight` are literal numbers, and the breakpoint is written out in two files. Unused tokens stay forever, because nothing reports them.

## Proposal

- **Type.**
  - Fix the root bug: the body sets the font, and the root keeps the browser's 16 px.
  - One scale on every device, built on Apple's text sizes (12, 13, 15, 17, 20, 22, 28, 34 at 16 px to the rem), each step with its line height and its tracking.
  - Twelve named roles map onto the eight steps, with three weights.
  - Nothing renders below 12 px.
- **Two token layers**, in their own file (`src/app/tokens.css`):
  - Primitives are named for what they are: a neutral ramp, four hues, alpha whites and blacks, the type steps, the radii.
  - Semantic tokens are named for what they do and refer only to primitives.
  - The MTA's line colours are a third, data layer, written as facts.
  - `globals.css` uses semantic tokens only.
- **Named layers and one breakpoint.** `z-index` comes from named layers. Font weights come from three tokens. The one breakpoint is declared once and checked everywhere it is written.
- **Layout primitives.** `Stack`, `Inline` and `Text` take only token values, and the new components use them.
- **The audit enforces all of it:**
  - no primitive used outside the token file;
  - no literal weight, z-index or line height;
  - no step below 12 px;
  - every breakpoint the same;
  - contrast of every label on every surface;
  - no unused tokens.
- **The `/design` page documents the result:** the type roles in a specimen, both colour layers with contrast figures, the layers, the motion and the governance rules.

## Acceptance criteria

- [x] On the desktop panel no rendered text is under 12 px, and a row's title renders at 17 px, measured in the browser.
- [x] `html` computes to a 16 px font size, and `--t-code` resolves to a valid font.
- [x] `globals.css` declares no tokens of its own and uses no primitive token. The audit fails a change that does either.
- [x] The audit fails a literal `font-weight`, `z-index` or `line-height`, a type step under 12 px, a breakpoint other than the declared one, a label under 4.5:1 on a surface, and an unused token.
- [x] `Stack`, `Inline` and `Text` exist in `src/components/ui`, take only token values, and are used by Nearby, LinesCard and the panel foot.
- [x] `/design` shows the type roles, both colour layers with contrast figures, the z layers and the governance rules.
- [x] `npm test`, lint, typecheck, `audit:design`, `audit:layout`, `audit:a11y` and `audit-ui` (desktop and phone) pass, and the live site is checked after the deploy.

## 2026-11-07

Measured on the local build, desktop panel, every text node: 12 px at the smallest (the counts under the bullets), 13 the footnotes, 15 the subtitles and controls, 17 the row titles, 20 the section headers. html computes 16 px; code 13 px. Before: 8.9, 9.75, 11.4, 12.2. Contrast: the gate found --label-3 on the search field at 3.87:1, and the standard system blue and red at 3.6 and 3.9 on a filled control; label-2/label-3 were lifted to #b4b4be/#9a9aa4 and text now uses Apple's increased-contrast blue and red, with the map's position dot keeping the standard blue as --map-you. Every new audit rule was proved by planting one violation of each and seeing it reported. Not built: Dialog, Menu, Tooltip, Toast, Checkbox, Radio — nothing in the app uses one, and the governance rules say a component waits for a real use. Not built: a light theme; the semantic layer is where it would go, but the basemap style is dark-only.

## 2026-11-07

Deployed as traintime-site ba94fb7c. Live desktop census: 12, 13, 15, 17, 20 px and nothing smaller; html 16 px; /design serves 200.
