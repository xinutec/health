---
created: 2026-11-03
status: step 1 live (the frontier logged, unchanged runs skipped); step 2 lemma proved, the build next
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

The packed decoder already stores columns as checkpoints and proves the walk
correct for any stride: every stored column equals `col` at its own time
(`Packed.lean`, `pBuildCkpt_fst`). A column depends only on the model at or
before its time: `col (t + 1) = colStep m t (col t)`. So two models that agree
on every entry a column up to `f` reads have the same columns up to `f`, and
a run may start from the last stored checkpoint before `f`.

The lemma to prove: if `m₁` and `m₂` agree on emissions, entries, transitions
and duration cells at every `t < f` (the cells by their END minute), then
`col m₁ t = col m₂ t` for `t ≤ f`. The walk then needs the tables for every
minute, so the stored tables for `e < f` are reused and only `e ≥ f` is built.

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

Per user and day, one file under the sidecar's tmp mount, named by the code
hash: the built rows, the per-minute tables and the checkpoints. A missing or
foreign file means a full decode. Its size is to be measured (the full
`PData` of a day is the upper bound, ~0.5–1 GB in the worker's RSS today;
the checkpoints alone are ~90 columns of `S × maxD`).

## Steps

1. **Measure the frontier.** A Lean mode compares a request's per-minute
   tables with the stored run's and returns `f` and which day-wide input
   moved; the sidecar logs it per decode and changes nothing else. One real day of logs says
   what share of each run the reuse would save.
   Live 2026-11-03; its first night: the frontier sits ~15 minutes before
   the run, a late upload or the sleep record moves it back (once to minute
   10), the rail relations' daily refresh moves every minute once a day, and
   one run in ten had nothing new. Such a run is not decoded: the same request
   under the same code (`GIT_SHA` and the classifier version) decodes to the
   stored result, so only `inputs_through` moves.
2. **The lemma** — PROVED 2026-11-03 (`Packed.lean`): models that agree on
   what a column up to `f` reads (`AgreeTo`) build the same checkpoints and
   columns up to `f` (`pBuildCkpt_agree`), and resuming the new model from the
   old run's checkpoints at a stride boundary `t0 ≤ f` (`resumeState`,
   `pResume`) decodes exactly as the new model from scratch (`pDecodeInc_eq`),
   so `pDecode_correct` covers it.
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

The incremental state is a stopgap (his word, 2026-11-03): the direction is a
decoder fast enough to compute any day on read, past days included, so that no
decode or state needs storing.
