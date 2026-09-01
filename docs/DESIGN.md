# The design system

Two sources, deliberately.

**The 1970 NYCTA Graphics Standards Manual** for the information design: Helvetica, sentence case,
hierarchy from size and space rather than rules and boxes, circles for local services and diamonds
for express, the MTA's own route colours used for nothing but routes.

**Apple's dark mode** for the surface treatment: near-black grounds, layered translucent material,
elevation carried by luminance and blur rather than borders, continuous radii, restrained accents,
one easing curve, and type that stays readable at a glance in a moving carriage.

The rule that holds it together is that **every value comes from the token layer**, and
`npm run audit:design` fails the build if one does not. That check is the point of this document —
a system nobody enforces is a style guide, and a style guide is a suggestion.

## Tokens

All of them live in one `:root` block in `src/app/globals.css`. There is no second place.

| group | what it covers |
|---|---|
| **surfaces** | `--ground`, `--surface`, `--surface-solid`, `--surface-3`, `--raise`, `--raise-2`, `--separator`, `--edge`, `--scrim` |
| **labels** | `--label`, `--label-2`, `--label-3`, `--on-accent` — Apple's hierarchy, tertiary held at ≥ 4.5:1 on the panel material |
| **accents** | `--accent`, `--amber`, `--red`, `--green`, and their tints. They carry meaning and nothing else |
| **MTA palette** | `--mta-red`, `--mta-blue`, `--mta-orange`, `--mta-grey` — only for the legend's samples of what the map draws |
| **type** | `--t-display` … `--t-code`, each paired with a `--tr-*` tracking |
| **radii** | `--r-inner` 6, `--r-chip` 8, `--r-card` 12, `--r-panel` 18, `--r-sheet` 24, `--r-pill` |
| **space** | `--s0` 2 … `--s8` 64, an 8-point grid |
| **sizes** | `--tap` 44, `--control-h` 32, `--icon`, `--dot`, `--bullet`, `--panel-w`, `--doc-w` |
| **motion** | `--ease` (one curve), `--fast`, `--slow`, `--ambient` |

## Type

One scale, in `rem` so a reader who scales text up gets a bigger interface rather than clipped
labels.

| step | size / weight | tracking | used for |
|---|---|---|---|
| `--t-display` | 1.9rem / 700 | −0.024em | the countdown on a phone |
| `--t-large` | 1.75rem / 700 | −0.022em | the countdown |
| `--t-title` | 1.25rem / 700 | −0.018em | station and train names |
| `--t-headline` | 0.9375rem / 600 | −0.01em | a destination in a list |
| `--t-body` | 0.8125rem / 400 | 0 | prose |
| `--t-caption` | 0.72rem / 400 | 0 | supporting detail |
| `--t-micro` | 0.625rem / 600 | +0.06em | the manual's all-caps labels |

**Tracking travels with size.** Helvetica was drawn for signage: it sets loose at small sizes and
looks loose at large ones, so the scale tightens as it grows and opens up for the all-caps labels.
Using a size without its tracking is how a scale quietly stops being one — the sizes stay right
and the texture drifts — so the audit rejects `font: var(--t-title)` unless the same rule sets
`letter-spacing: var(--tr-title)`. Capitals are the one exception, and they have to say so:
`text-transform: uppercase` may take the looser caps tracking at any size.

Numbers are always tabular, so a countdown never reflows as it ticks.

## Space

An 8-point grid, with 2 and 4 available for the optical corrections that hold small things
together. Nothing is off it. Before this was enforced the stylesheet carried 3, 5, 6, 7, 9, 10,
11, 14, 15, 22, 26, 30, 34 and 36 pixel values — every one of them defensible on its own, and
together an interface with no rhythm.

## Touch

`--tap` is 44px, and on phones everything you can press is at least that on its short side.
Pointers get `--control-h` (32px), which is the right size for a mouse and the wrong size for a
thumb; the phone media query raises them.

## What the audit checks

`npm run audit:design` reads the token layer and then every rule in the stylesheet, and fails on:

- **duplicate** — a rule that sets the same property twice in the same block. One of them is dead,
  and which one is whichever came last, which is never what anybody meant. It found two rules
  copy-pasted whole.
- **colour** — any hex or `rgb()` outside `:root`.
- **type** — a `font` or `font-size` that is not one of the named styles.
- **tracking** — a type style used without the tracking that belongs to it.
- **spacing** — a px value in a layout property that is not on the scale.
- **radius** — a corner that is not a named radius.
- **motion** — a duration or easing typed in by hand.
- **tap-target** — an interactive control below the touch target.

It found **155 divergences** the first time it ran, on a stylesheet that had already been through
a "apply an 8-point grid everywhere" pass. That gap between believing a system is applied and
having a machine check it is the entire argument for the script.

## Usability decisions worth recording

**The countdown comes first.** A station board opened on a phone showed the app title, the running
train count, the station, a destination picker and two service-change cards — and not one train
time above the fold. You opened a station and could not see a train. Now a service change is a
single line that opens, the destination picker sits after the arrivals, and the brand stands down
to a quiet label once the sheet has an answer in it. Three arrivals are visible where none were.

**Alerts are not decoration and not an obstacle.** A reroute changes whether the train in front of
you is any use, so it stays in sight — as one row, coloured by severity, that opens to the full
text.
