---
id: 36
uid: 8d9159a0-64bb-4348-8bc3-7e94798fdc05
title: Write down what bound is, and what it refuses to be
type: docs
status: backlog
milestone: commute
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: s
area: site
---

## Problem

The product's direction lives in a conversation. The next person to add a feature has no way to
know that bound deliberately does not route multimodal journeys, has no social layer, and never
hides its uncertainty to look confident — so each of those will be proposed again, and one day
built.

## Proposal

A "What bound is" section in README.md, under ten sentences:

- **The thesis.** A companion that knows the subway as it actually is — where every train is,
  how sure we are, how today compares with normal — and tells you what to do.
- **The edge it protects.** Calibrated uncertainty, stated rather than hidden.
- **What it refuses, each with its reason:**
  - general A→B routing, which Google and Apple own; bound stays on which train, when to leave,
    where to change;
  - social features, crowding reports and ads, which each weaken "this is true and this is how
    sure we are";
  - false precision.

AGENTS.md points to the section, so an agent proposing work reads it first.

## Acceptance criteria

- [ ] README.md has a "What bound is" section stating the thesis and the three refusals, each refusal with its reason
- [ ] AGENTS.md links to that section in one line
