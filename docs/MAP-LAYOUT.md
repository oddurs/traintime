# Drawing the tracks

The MTA's 2025 map broke with the old convention of one line per trunk colour: the 4, 5 and 6 are
now three green bands, not one green line. This is how traintime does the same thing on a
geographic map, where the lines have to sit on real track and carry real trains.

## What was wrong

The first version drew one band per trunk *colour* and computed the band per *segment*, centred on
however many services happened to share that segment. Four defects came out of that, all of which
a rider could see:

| defect | evidence |
|---|---|
| **A service moved sideways when a different service turned up.** Bands were centred, so the count changing shifted everyone. | The N stepped 3 m sideways at 86 St because the W joined, and back at 59 St when it left. |
| **Bands drifted with no cause at all.** Corridor membership came from sampling cells and comparing bearings, which was not stable. | The F changed band at 2 Av and at 7 Av with the corridor around it completely unchanged. Sixty percent of the network's band changes were this. |
| **A band could land on the wrong side of the track.** The offset was applied relative to each segment's stored point order, which is sorted by station id, not geography. | **125 of 578 segments — 22%** — were mirrored relative to their neighbours. |
| **Trains did not sit on their own lines.** Lines and trains computed their offsets separately and disagreed. | A train sat 6 m off its line normally and 9 m off it once the view was narrowed to a few services. |

## How it works now

**Bands are per service.** Every service in a corridor gets its own lane, and no two ever share
one — asserted in the tests, which caught the smoothing pass quietly collapsing the 2 and the 3
onto the same band.

**Corridors are found by overlap, not by sampling.** Two stretches share a corridor when one runs
within 45 m of the other for at least 60% of its length. An isolated disagreement between two
identical neighbours is then smoothed away as the noise it is.

**Every stretch knows which way it runs.** An orientation is propagated across stations between
stretches that genuinely continue into one another, so "the third band from the left" means the
same side of the track everywhere, whatever order the station ids happen to sort in.

**A change of band is a splay, not a step.** Where a service moves between bands, the stretches
either side of the station each ease to the mean of the bands their *through* group uses, so the
two halves meet exactly and the line sweeps across the corner. Only through-tracks are in the
group: including branches too made every junction pinch down to a single band before fanning out
again, which was visible at Canal St.

**Bands cannot invert on a bend.** Offsetting a polyline towards the inside of a curve by more
than the curve's own radius turns it inside out, and the inner bands of a bundle came out as a
knot. The offset is now held short of the centre of the turn, so bundles stay nested through
90-degree corners.

**The weave is consistent.** Bands further right always pass over bands further left, drawn as
five casing-and-line layer pairs. A single casing layer beneath every line — the previous
arrangement — cannot show a crossing at all, because the casing is under both strokes.

## The fan

Real track centres are 4.6 m apart. That is a fortieth of a pixel at city zoom and about five
pixels at zoom 17, against a casing six pixels wide — so drawing the truth alone means every
corridor is a single fused slab at every zoom anyone actually uses.

So the geometry carries the true 4.6 m, and the separation that makes services legible is added on
top as a **pixel** offset. That distinction matters more than it sounds:

- Baked into the geometry, the fan can only change by re-laying the network, which can only happen
  in steps — and the map visibly jumped every time the zoom crossed one.
- As a paint property the renderer interpolates it every frame, so the bands ease apart and back
  together continuously.

The fan is **two curves, not one**, because two lines of different colours and two services
sharing one are not the same question:

| | zoom 12 | zoom 14.5 | zoom 16 | zoom 19 |
|---|---|---|---|---|
| between trunk colours | 11 px | 10.5 px | 9 px | 0 |
| between services sharing a colour | **0** | 5 px | 8.5 px | 0 |

A colour is a line on any map of this system and stays apart at every zoom. The 4, 5 and 6 are one
green Lexington line until you are close enough to care which is which — below about zoom 14 they
sit exactly on top of one another, and they part as you come in. That is what the printed map
does, and it is what keeps a city-wide view from turning every trunk into a smear.

Both curves fall to zero by zoom 19, where the true 4.6 m has grown past ten pixels and is doing
the whole job on its own.

Trains are placed on the same curves, converted to metres for the zoom being drawn, from the same
table the renderer reads — so a train cannot drift off its own line at any zoom. The sign is
resolved in one place, because a line is offset to the right of the direction it happens to be
*drawn* and a train relative to the direction it is *travelling*, and those are only the same side
when the two agree.

One MapLibre trap is load-bearing enough to be asserted in a test: a zoom interpolation must be
the outermost expression. Nested inside a multiply it is not rejected loudly — the layer is
silently dropped, which took most of the network off the map.


## Drawing the stations

Every station used to be the same grey dot, which threw away most of what the system is:

| | |
|---|---|
| terminals — a service starts or ends there | **80** (18 for more than one service) |
| interchanges — three or more services at one complex | **133** |
| single-service stops | 153 |
| largest complex | Times Sq, **13 services** |
| places a service's band is drawn *through* a station it never stops at | **302** |

That last row is the one that was actually wrong rather than merely flat. The 6X band runs past
125 St, 116 St and 110 St, and the map put a station dot on it with nothing to say the express
does not stop.

The printed map has had a vocabulary for this since 1970, so this borrows it:

- **a plain stop** is a small dark tick on the line
- **an interchange** is the larger light circle, and its name is set in bold at a larger size
- **a terminal** carries an outer ring, because the line ends there — drawn as a ring rather than
  a bigger dot so a terminal that is also an interchange reads as both
- **a station a shown service runs past** is dimmed. Filter to an express and the stops it skips
  recede, rather than sitting there looking like somewhere you could get off.

## Terminals are a different place

A train pulling into a terminal is ending its run; the one a rider can act on is the next to
leave. So when every train listed for a direction begins its run at that station, the board says
**Departures**, a train standing there reads "at the platform, ready to leave", and the countdown
says **go** rather than **now**.
