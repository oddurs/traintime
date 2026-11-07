---
id: 41
uid: fccb8e51-781b-4dc9-8c8a-f8008e070ef6
title: 'Web push for leave-by alerts: what the platforms allow, and where it runs'
type: spike
status: backlog
milestone: commute
depends_on:
- 37
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: platform
---

## Question

Can bound send "your 8:42 is held — take the 8:47" to a phone, reliably, without becoming a
service that knows who everyone is and where they commute?

## Leading hypothesis

Standard Web Push with VAPID works on Android Chrome and on an installed iOS web app. The poller
evaluates each subscription's leave-by against live state at most once a minute, and sends only
when the named train changes or its leave time moves by two minutes or more. A subscription
stores the push endpoint, a station, a direction and a time window, and nothing else: no
account, no location history.

## How to answer it

- Send one push to an installed iPhone and an Android phone from a throwaway VAPID key.
- Measure how late it arrives and how often it is dropped across 20 sends.
- Check the iOS rules: install required, permission prompt only on a user gesture, delivery with
  the app closed.
- Estimate the poller's cost at 1,000 subscriptions per minute of evaluation.
- Write down what a subscription stores and how it is deleted.

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
