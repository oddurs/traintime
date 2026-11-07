---
id: 44
uid: 37e7c3d2-5c3e-4680-a43d-926bf46281e6
title: Show how likely a transfer is on the faster-connection offer
type: feature
status: backlog
milestone: commute
depends_on:
- 43
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: m
area: front-end
---

## Problem

A faster connection that works half the time is not faster for half the people who take it, and
the offer does not say so.

## Proposal

If the spike finds the probabilities are calibrated, the Callout in the train view adds one
phrase, such as "you make this change about half the time". The phrase comes from a bucketed
probability: usually (over 80 %), most of the time (60–80 %), about half the time (40–60 %).
Under 40 % the offer is not made at all.

## Acceptance criteria

- [ ] the phrase shown is backed by the calibration the spike recorded, cited in the PR
- [ ] an offer under 40 % is never shown, covered by a test on the bucketing function
