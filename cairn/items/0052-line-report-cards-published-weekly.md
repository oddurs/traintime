---
id: 52
uid: a3e0cd83-dc86-48d1-90ba-9fe97a15af94
title: Line report cards, published weekly
type: feature
status: backlog
milestone: record
depends_on:
- 51
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: site
---

## Problem

The figures are only a public record when someone can read them, link them and quote them.

## Proposal

- `/report/` shows the latest week, one card per line, grouped by trunk. Each card shows:
  - one sentence, such as "Ran normally" or "34 % slower than normal in the morning peak";
  - the figures for each period, with marks rather than coloured text (the design rule);
  - the worst hours.
- `/report/2026-W45/` is a permanent URL for each week.
- A "How this is measured" section states the definition the spike settled.
- Built statically from the endpoint at deploy, so the site stays static.

## Acceptance criteria

- [ ] the latest week and every past week have their own URL, and a past week's page never changes
- [ ] each card's sentence is generated from the figures by a tested function, so the words cannot disagree with the numbers
- [ ] the method section states the baseline, the noise floor and the data limits, in plain words
- [ ] audit-design and audit-a11y pass on the page
