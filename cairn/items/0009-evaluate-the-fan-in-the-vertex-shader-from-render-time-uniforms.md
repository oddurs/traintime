---
id: 9
title: Evaluate the fan in the vertex shader from render-time uniforms
type: feature
status: backlog
milestone: render-2
depends_on:
- 8
created: 2026-09-17
updated: 2026-09-17
priority: p0
effort: m
area: map
---

## Problem

The fan has to be evaluated with the camera the frame is actually drawn with.
MapLibre hands the custom layer that camera in `render()`; nothing else in the
codebase has access to it, which is why the CPU copy reads `map.getZoom()` and
is wrong by one frame during any gesture.

Once the band coefficients are in the buffer, the offset is three lines of GLSL
against one uniform — and it is then the *same* offset the line gets, because it
is the same formula evaluated at the same instant.

## Acceptance criteria

- [ ] The fan is set as uniforms inside `TrainLayer.render()`, from the frame's own camera
- [ ] The shader applies `a_cb * fan.colour + a_mb * fan.metric` in pixels
- [ ] `fanned()`, `fanScale` and the `lastBand` map are deleted
- [ ] `metresPerPixel` is no longer called per train
- [ ] A train holds its lateral position through a fast pinch, checked by eye and on video
