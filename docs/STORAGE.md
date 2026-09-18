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

## What recovery looked like

The first boot of the fixed poller reclaimed the volume from 4,998 MB to **3,258 MB** — ticks 2,989,
eta_obs 218, events 46, trips 5, rollups 0 — and came back with 8/8 feeds and 492 trains. Most of
that was not the budget: it was twelve hours of `prune` that could not run, deleting ticks past
their three days and observations past their fourteen. Fifteen days later it is stable at 4,235 MB
inside a 4,500 MB budget, with 51,000 fetches and two errors.

## Why a merge is grouped by the hour, not the day

Measured 18 September 2026, from the hourly pass:

```
[maintenance] skipped compacting ticks/2026-09-16: needs 973 MB to merge and 578 MB is free
[maintenance] skipped compacting ticks/2026-09-17: needs 928 MB to merge and 578 MB is free
[maintenance] compacted {"ticks":5,"events":12,"eta_obs":13,"trips":13} ... disk 4235 MB
```

A merge rewrites its whole group before it may delete any of it, so the group has to be something
the volume can hold **twice**. Grouping ticks by day asked for 973 MB against 578 MB free, which is
not a shortfall that a bigger budget fixes: the budget is what leaves the headroom, so raising one
lowers the other. The largest table cannot be rewritten a day at a time on a volume sized for three
days of it, at any setting.

So the unit is now per-table. Ticks group by hour — ~34 MB, which always fits — and everything else
still groups by day. A tick day goes from 288 flush files to 24 rather than to 1, which is most of
the read-speed win for a cost the budget can actually pay. Events are 6.5 MB a day and observations
33 MB, so a day of those merges for almost nothing and a year of them stays cheap to read.

## The rollup could never have run

`/health` reported `summarised: { days: 0, from: null, to: null }` and this was read as "there was
nothing to summarise". It was not. Two windows had to agree and did not:

```
rollup eligible at   21 days   (ROLLUP_AFTER_DAYS)
prune deletes at     14 days   (obsDays)
```

Every observation day was deleted a full week before it became eligible, so the pair was
unsatisfiable and the summariser was unreachable — not slow, not broken, just never called with
anything. The learner's cold-history path in `scripts/learn-timing.ts`, the one commented
"everything already summarised — these are the months the raw rows no longer exist for", was always
going to add zero rows.

It was reachable once: the observation window was 30 days until the retention tightening in
`81e34f1` cut it to 14 to buy disk back for ticks. Nothing connected the two numbers, so one moved
and the other did not. That is the actual defect, and the fix is not a better constant —
`rollupAfterDays()` now derives the window from the policy as `obsDays - 1`, which is twenty-four
hourly chances to summarise a day before it is pruned, and clamps any `ROLLUP_AFTER_DAYS` override
back inside the window with a warning. There is no pair of values a future tightening can leave in
this state.

## Why an unsummarised day is held rather than deleted

`rollup.ts` says the raw rows are only removed once their rollup is safely on disk. That was true of
its own deletions and false of `prune`'s, which went by age and knew nothing about rollups — so the
promise held only for as long as the one-day margin between the two windows, and an outage longer
than a day walked straight past it. The twelve-hour crash loop above is most of that margin; a
slightly worse one would have destroyed residual history that nothing can reconstruct, silently.

So `prune` now consults `summarisedDays()` and holds an observation day whose summary is not on
disk. Held, not kept: after `obsGraceDays` (7) it goes regardless, because a summariser that is
broken must not also become a volume that fills. The worst case is 0.23 GB of extra observations and
a warning on every pass, which is the only signal that arrives *before* the day is gone for good.

In normal operation none of this is reachable — `rollup` consumes a day at `obsDays - 1` and leaves
`prune` nothing to find. It exists for the case where the summariser fell behind, which is precisely
when the loss would be permanent.

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

## What more data will not fix

`INCOMING_AT` is the only true position measurement in the feed; everything else is inference from
predicted times. Deeper history sharpens the timing tables and the residual corrections, and it will
never turn one measurement per approach into continuous truth. Past a few months of events the
returns shift from "the tables are noisy" to "the feed does not say", which is a different problem
and wants better inference between measurements rather than more bytes.
