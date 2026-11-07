---
id: 43
uid: 4cb1a5eb-095c-46c5-ac72-ffe58d451b66
title: Can we honestly say how likely a transfer is?
type: spike
status: backlog
milestone: commute
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: m
area: data
---

## Question

The faster-connection offer ("change at Union Sq for the 4, about 3 min sooner",
`betterConnection` in src/lib/connection.ts) presents a transfer as certain. Can bound say how
often a transfer like it is actually made, and be right about that?

## Leading hypothesis

Arrival errors on two different lines are close to independent. Treat each as Gaussian with its
calibrated σ, and the chance of making a transfer with `w` seconds of walking is
P(arrival₂ − arrival₁ > w). If that holds, the probability can be shown honestly in buckets such
as "usually", "about half the time" and "rarely".

## How to answer it

- From recorded arrivals, find every pair of trains that a rider changing at a station could have
  connected, and the margin they had.
- Compare the predicted probability with the observed share made, per decile.
- Check whether errors on the two lines are correlated in the morning peak, when they share
  causes.

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
