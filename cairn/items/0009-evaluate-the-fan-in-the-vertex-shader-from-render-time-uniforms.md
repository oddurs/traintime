---
id: 9
title: Evaluate the fan in the vertex shader from render-time uniforms
type: feature
status: done
milestone: render-2
depends_on:
- 8
created: 2026-09-17
updated: 2026-09-18
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

- [x] The fan is set as uniforms inside `TrainLayer.render()`, from the frame's own camera
- [x] The shader applies `a_cb * fan.colour + a_mb * fan.metric` in pixels
- [x] `fanned()`, `fanScale` and the `lastBand` map are deleted
- [x] `metresPerPixel` is no longer called per train
- [x] A train holds its lateral position through a fast pinch, checked by eye and on video

## Measured: the error was real and sub-pixel

The fan is evaluated in the vertex shader from u_fan, set inside
TrainLayer.render() where map.getZoom() is the transform MapLibre is about to
draw. fanned(), the per-frame metresPerPixel/fanAt pair and the per-train
trigonometry are gone; fanScale reaches the layer as a closure so the curve is
still evaluated at draw time rather than handed over as a finished number.

Then measured, because the claim deserved a number. scripts/audit-fan.mjs
records the zoom a requestAnimationFrame callback sees and the zoom the render
that follows it sees, pairs them, and evaluates the real fanAt at both — which
is exactly the error the old code committed, without needing to read anything
back off the GPU.

Lateral error, band two tracks out, zoom 14.4 -> 17.2:

  cpu   mean   p95    max
  1x    0.08   0.19   0.70 px
  4x    0.09   0.21   0.80 px
  8x    0.09   0.35   0.75 px

So the desync was real, and sub-pixel — against a fan eleven to seventeen
pixels wide. Under a pixel at p95 even with the CPU throttled eight times. The
plan presented this as the cause of the visible jank and it is not; nobody has
ever seen it.

What the change is actually worth: one derivation instead of two, so render-3
can stroke the lines from the same function rather than a fifteen-stop
approximation of it. That is structural, and it is the reason to have done it.
Plus about 13% off our own frame callback (1.20 -> 1.05 ms mean), which was
already cheap.

Recorded in docs/RENDER.md under "This milestone was justified on the wrong
grounds", so the next milestone is argued from measurements rather than from
this one's rhetoric.
