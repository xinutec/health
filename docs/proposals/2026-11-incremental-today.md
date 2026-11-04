---
created: 2026-11-03
status: live 2026-11-03 (assemblesegmentsinc on the decode watch's own worker); refinements open
references:
  - decoder-roadmap.md
  - ../design/lean-and-rust.md
---

# Today, decoded from the earliest changed minute

## Why

The decode sidecar re-decodes today from scratch whenever its inputs grow:
about every 15 minutes, 90 s each on its one CPU (2026-11-02). Each run
re-derives every table for minutes whose inputs have not changed since the
last run. His decision (2026-11-02): no extra CPUs; less work for the same
answer, and an exact incremental state is allowed because the full decode
still runs, visibly, on every new day, version bump and history re-decode.

Measured on the way (2026-11-02/03): a near-empty day decodes in 19 s in
production, so the cost is in the minutes with data, not the empty rest of
the day; and the journey pass is the largest phase on every day.

## The invariant it rests on

The decoder keeps, per minute and state, the score of entering the state and
its best close (`ByStart.lean`): a minute's rows read the model at that
minute or before, and the closes read the duration cells ending before it.
So two models that agree on everything up to `f` (`AgreeTo`) build the same
rows up to `f` (`sBuild_agree`), and a build to a later minute only appends
rows (`sBuild_prefix`). The earlier run's rows, cut at `f` and built on with
the new model, are the new model's own (`sDecodeInc_eq`), so `sDecode_correct`
covers the incremental decode.

## The frontier

`f` is the first minute at which any PER-MINUTE table differs from the
stored run's: the observation rows, each mode's emission and entry, the
transitions, and the journey's per-minute inputs (each leg's reach starts,
board term, alight station, calling evidence). These are the cheap phases
(under a second a day); the expensive ones (duration cells, the journey
sweeps, the trellis) are functions of them over a cell's own window, and are
the ones reused.

Comparing the tables, not the raw inputs, is what makes this exact without an
inventory of who reads ahead. Rows and terms do change backwards:

- `nextGpsFix` carries the next fix back over every dark minute, so a fix
  after a dark stretch changes the whole stretch;
- cadence imputation looks ahead `WATCH_LIVENESS_WINDOW_MIN`;
- `inBed` arrives with the sleep record, which covers the night;
- a ride's reach start at `t` reads minute `t + 1`;
- a station pass is a run of minutes, and the calling evidence of a leg
  ending at `e` reads whether the pass under way at `e` runs past it;
- `dayHasStepRows` is day-wide;
- the phone and the watch upload late.

A difference in a day-wide input sets `f = 0`: the graph, the places, the
rail relations, the place-near-line pairs, the continuity seed, the record,
or the code version.

A duration cell `(d, e)` reads the tables at `e − d + 1 … e`, and a journey
cell ending at `e` reads the same window, so both are rebuilt for `e ≥ f`;
the journey's sweeps then start at `f − maxJ` or later.

## Where the state lives

In the long-lived worker's memory (step 3): the day's `PData`, its journey
tables and the decoder's rows, two `T × S` arrays of `Nat` (~2.6 MB on
2026-11-02's 115 states). A new key or no earlier run means a full decode.

## Steps

1. **Measure the frontier** — done 2026-11-03, and retired the same day: the
   frontier is now the incremental run's own, reported per decode. Its first
   night: the frontier sits ~15 minutes before the run, a late upload or the
   sleep record moves it back (once to minute 10), the rail relations' daily
   refresh moves every minute once a day, and one run in ten had nothing new.
2. **The lemma** — PROVED 2026-11-03 (`Packed.lean`): models that agree on
   what a column up to `f` reads (`AgreeTo`) build the same checkpoints and
   columns up to `f` (`pBuildCkpt_agree`), and resuming the new model from the
   old run's checkpoints at a stride boundary `t0 ≤ f` (`resumeState`,
   `pResume`) decodes exactly as the new model from scratch (`pDecodeInc_eq`),
   so `pDecode_correct` covers it. Superseded 2026-11-04 with the checkpoint
   decoder itself: the by-start rows resume at `f` exactly (`sDecodeInc_eq`).
   Then the incremental build, in Lean: emissions, entries and transitions
   rebuilt whole (cheap); `f` computed from the old and new per-minute tables
   (the first minute any differs, less one — `AgreeTo` checked, not assumed);
   duration cells and the journey's sweeps only for ends at or after `f`,
   the rest copied. Equal to the full decode on every frozen day cut at
   several frontiers, and on a real day's consecutive requests.
3. **The sidecar** keeps the state in one long-lived Lean worker for today,
   held by the watch loop (today's decodes run as child processes now, which
   is why nothing survives a run); every other decode stays full. In memory,
   his choice 2026-11-03, about 140 MB by that day's measurements.

**Live 2026-11-03.** First runs in production: a full decode 45 s (7 s the
request, 38 s Lean), the next incremental 33 s (8 + 26), its frontier at minute
833 set by `journey.stopPre`. The tables are built once a run since
(`buildPre`). Open: a station pass still under way changes its calling
evidence from its start every minute, though no leg ending before the pass
ends reads it. Kept by its last minute the frontier would sit at the present,
but that form also ends a double subtraction of the arrival pass which, it
turned out, is what keeps a ride from splitting at a calling station (06-23);
it waits on a fitted prior for changing to the same line, which is model work.

The incremental state is a stopgap (his word, 2026-11-03): the direction is a
decoder fast enough to compute any day on read, past days included, so that no
decode or state needs storing.
