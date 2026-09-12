# Storage

What the archive costs, what it buys, and what is deliberately not built yet.

Measured 3 September 2026, from the live volume and 2.4 days of recordings.

## Where the bytes go

| table | size | share | rate |
|---|---|---|---|
| ticks | 2,043.9 MB | **95.2%** | ~820 MB/day |
| eta_obs | 85.5 MB | 4.0% | ~33 MB/day |
| events | 16.9 MB | 0.8% | ~6.5 MB/day |
| trips, weather, calendar | 0.8 MB | 0.0% | — |

Ticks are raw GTFS-realtime protobuf, gzipped by the recorder before the appender and then written
to Parquet with ZSTD. There is no codec win left: 35 KB/tick on the numbered-lines feed is already
post-compression, and that one feed is 56% of the whole archive. Nor is there a dedup win — zero
percent of consecutive ticks are byte-identical, because the feed header timestamp moves every time
even when nothing else does.

## Where the accuracy comes from

The learned tables, over a 2.4-day window:

| table | cells | median n | p10 | under 10 samples |
|---|---|---|---|---|
| runTime (per segment) | 1,251 | 368 | 14 | 8% |
| **runTimeHour** | 24,779 | **16** | 6 | **23%** |
| dwell (per stop) | 944 | 455 | 269 | 0% |
| **dwellHour** | 21,990 | **17** | 7 | **21%** |
| residual | 5,679 | 336 | 1 | 28% |

The coarse tables are healthy; the per-hour ones are built from a median of sixteen samples. A
median from sixteen draws carries about 0.31σ of standard error, which against the ±18 s run-time
spread is roughly **±6 s of estimation noise inside the table itself**, before the model is wrong
about anything in the world.

So: **the data that costs the most buys the least.** Ticks are 95% of the volume and contribute no
prediction accuracy directly — they exist so events can be re-derived when the tracker changes.
Events are 0.8% of the volume and are what every model learns from.

## What the windows are, and why

`DEFAULT_POLICY` in `services/poller/retention.ts`:

```
events   365 days   2.37 GB   what every model learns from, and the cheapest table there is
obs       14 days   0.46 GB   the residual tables are the least starved of the three
trips    365 days   0.11 GB
ticks    the rest   ~1.5 GB   about two days, and only ever needed to re-derive the above
                    -------
                     4.5 GB   budget, +0.4 GB free floor, against a 5 GB volume
```

These have to add up. A policy that asks for more than the volume holds does not degrade
gracefully: `enforceBudget` can only delete ticks, so once the tables it cannot touch exceed the
budget on their own it deletes every tick file except the newest, every pass, and is still over.
The previous defaults reached that state on their own — 400 days of events and 30 of observations
come to 3.71 GB against a 3 GB budget — and nothing said so. It now returns `unreachableBytes`,
warns on every pass, and reports it under `recorder.retention` on `/health`.

## Cost

Railway volumes are **$0.15/GB/month**, and the Hobby plan caps a volume at **5 GB** — which is the
size already in use. The next gigabyte is not fifteen cents, it is a **$20/month Pro plan**.

A year of ticks is **299 GB**:

| | rate | 299 GB/month |
|---|---|---|
| Railway volume | $0.15/GB | $45 + forced Pro upgrade = **~$60/mo** |
| Cloudflare R2 | $0.015/GB | **$4.50/mo**, no egress fees, first 10 GB free |
| S3 Standard | ~$0.023/GB | ~$6.90/mo plus egress |

Railway volumes are ten times R2's price. They are hot, replicated block storage attached to a
running service, and priced for that; a cold protobuf archive does not belong on one.

The accuracy win needs none of this. A year of events is 2.37 GB and fits the volume already paid
for, which is why the retention change above was worth making on its own.

## How the volume filled anyway

Measured 12 September 2026, from a poller that had been in a crash loop since the small hours.
Memory was never near it: the peak was 5.1 GB against an 8 GB limit.

The volume hit 4,998 MB of 5,000 and the poller died every five minutes with
`IO Error: Could not write file ".../ticks/….parquet": No space left on device`. Four separate
defects had to line up, and each one on its own would have been survivable:

1. **Housekeeping freed space last.** The hourly pass ran `flush → compact → rollup → prune →
   enforceBudget`. Every step that writes came before every step that deletes, and the whole pass
   sat in one `try`. On a full volume it threw on its first line and pruning never ran — the only
   code that could free the disk was sequenced behind three operations that needed it freed.
2. **Compaction could never have fit.** Merging a day rewrites it entirely before deleting any of
   it, so a day of ticks needs its own 820 MB free on top of itself; the budget leaves about 490.
   So the merge wrote until the disk was full and then failed — which is the likeliest way the
   last 490 MB went in the first place.
3. **A failed flush killed the process.** The interval callback was `async` and nothing awaited
   it, so Node's default for an unhandled rejection turned a full disk into an uncaught exception.
   The poller died at minute five of every boot, which meant the hourly pass — even correctly
   ordered — was never once reached.
4. **The budget could not see `rollups/`.** `diskUsage()` walked `TABLES`, and the summariser's
   output is not a table. This one is latent rather than guilty: the live volume holds 0 MB of
   rollups, so it contributed nothing here — see "the rollup that has never run" below. It is
   listed because it is the same mistake as the other three, and it would have mattered on the
   day the summariser started working.

What changed: deleting is split out as `reclaim()` and runs first in the pass, on every boot, and
again whenever a flush reports no space. Each housekeeping step fails on its own now instead of
cancelling the rest. Compaction checks it has room before it starts and skips the day if it does
not. `diskUsage()` and `cleanTemp()` walk every directory under `rec/` rather than a list of names.
And when the budget and the free floor both bite, the tighter of the two wins, so one pass reaches
the number one pass had the information to reach.

## What recovery looked like, and when compaction stops fitting

The first boot of the fixed poller reclaimed the volume from 4,998 MB to **3,258 MB** — ticks 2,989,
eta_obs 218, events 46, trips 5, rollups 0 — and came back with 8/8 feeds and 492 trains. Most of
that was not the budget: it was twelve hours of `prune` that could not run, deleting ticks past
their three days and observations past their fourteen.

So there is about 1.7 GB free today and compaction fits comfortably. It will not stay that way. The
budget binds as events accumulate — they are 46 MB now and 2.37 GB at a year — and at saturation
`rec/` sits at the 4.5 GB budget with roughly 490 MB free. A day of ticks is ~820 MB and a merge
needs that much again before it may delete anything, so **tick compaction starts being skipped once
events have grown in**, and says so once an hour.

Lowering the budget far enough to afford the merge costs about a day of ticks to buy back the room
to tidy the day before it: the largest table cannot be compacted without reserving its own size, and
on a 5 GB volume that trade does not pay.

The open question is whether ticks should be exempt from compaction outright rather than attempted
and skipped. Compaction exists to keep reads fast, and ticks are read only to re-derive events;
events and observations are 6.5 MB and 33 MB a day and merge for almost nothing. Leaving ticks as
~288 flush files a day is probably the honest default — but it should be written down as a decision
rather than emerge from a warning nobody reads.

---

# Not built yet

## Tiering ticks to object storage

Retention deletes evicted tick files. It should be able to hand them to an archiver instead: a seam
in `enforceBudget` where the default archiver is `unlink` — today's behaviour exactly — and an
S3-compatible driver sits behind environment variables.

That would make re-derivation a batch job streaming from cold storage rather than something that is
simply impossible past two days, which today quietly caps how far back any tracker change can be
validated against reality.

Not built because it needs a bucket and credentials to test against, and an untested cloud driver
is worse than none. When there is somewhere for the bytes to go, the work is the seam, the driver,
and a `rebuild-events` that can read from it.

**Downsampling is not an alternative.** Keeping one tick in six past 48 hours would cut the cost by
the same factor, and it does not work: `rebuild-events` derives arrivals and departures from
consecutive tick diffs, so 30-second sampling blurs event timestamps by ±30 s against a 56 s median
dwell. Ticks are all-or-nothing. Tiering is the only way to keep them.

## The rollup that has never run

`/health` reports `summarised: { days: 0, from: null, to: null }`. Whatever `services/poller/rollup.ts`
was meant to produce, it has produced nothing, so there is no middle tier between full fidelity and
gone — which is exactly the tier that would let ticks age out without losing their information.

Either it should emit real daily summaries of ticks on their way out, or it should be deleted. Dead
code that claims to summarise is worse than no code, because `summarised: {days: 0}` reads as "there
was nothing to summarise" rather than "this has never worked".

## What more data will not fix

`INCOMING_AT` is the only true position measurement in the feed; everything else is inference from
predicted times. Deeper history sharpens the timing tables and the residual corrections, and it will
never turn one measurement per approach into continuous truth. Past a few months of events the
returns shift from "the tables are noisy" to "the feed does not say", which is a different problem
and wants better inference between measurements rather than more bytes.
