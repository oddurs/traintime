---
id: 2
uid: 30d62b3e-4d41-46df-bc43-a0bd69069bd8
key: render-2
title: One fan, in the shader
type: milestone
status: done
created: 2026-09-17
updated: 2026-09-18
priority: p2
---

Delete the second derivation of the fan rather than reconcile it.

Every service is drawn as a stroke shifted sideways from its corridor centreline,
so five lines sharing Queens Boulevard read as five lines. That shift — the *fan*
— currently exists twice:

    lines   line-offset, in PIXELS, interpolated over 15 zoom stops,
            evaluated at draw time with the camera MapLibre is drawing with
    trains  metresPerPixel(zoom) * fanAt(zoom), in METRES, computed per train
            on the CPU from a map.getZoom() read taken before that camera exists

They agree only when the camera is still and the line is straight. There is no
correct way to keep two derivations of one quantity in step — every fix that
keeps both is a tighter tolerance on a race.

After this milestone, trains and lines do not *agree*; they are the same number.
