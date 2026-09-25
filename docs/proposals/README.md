# Proposals

In-flight design work for health-sync — substantial architecture or
pipeline changes being thought through, built, or finished. Each file
here has live work remaining.

**This directory is staging, not a log.** When a proposal's work is
fully done (shipped with no remaining phases), superseded, or
abandoned: summarise the durable, current-behaviour parts into
`docs/design/` and **delete the proposal**. Git history is the log —
it keeps the full text and the commit that landed it, so a kept `.md`
copy would just be a worse version of `git log`. A "this happened"
doc with no live work does not belong here.

`docs/design/` is the source of truth for how the system works *now*.
A proposal that has shipped describes current behaviour, so its
content belongs there, where a reader looking up "how does X work"
will find it.

## In flight

| File | Status | Topic |
|---|---|---|
| `decoder-roadmap.md` | active | **The single forward plan for the decoder line of work.** One joint probabilistic decoder owning a continuous map-matched worldline; Phases 0–5 |
| `geometry-roadmap.md` | active | **The single forward plan for the positioning/geometry line of work.** A moving leg as the MAP estimate of one robust energy; Phases G0–G4, the measured landmines |
| `2026-07-continuity-c4.md` | C4.0–C4.3 live; C4.4 open | Cross-segment continuity (#224): the acceptance suite (#327), the cadence-null emission hole, the journey-authority flip |
| `2026-07-soft-venue-attribution.md` | P0 shipped; P1 truth-neutral, unshipped | The venue-naming lead (#325 owns the blocker): weight, don't filter — posterior-weighted attribution with an `other` component |
| `2026-07-venue-measurement-model.md` | V0 shipped; V1 refuted by V0 | Venues as extents, the sensor's lie learned. Read "What V0 measured" before acting on it |
| `2026-06-magnetic-focus-places.md` | shipped; Phase 3 deferred | Place attribution as a stateful pull from focus_places. Phase 3 (magnet on unmined locations) remains |
| `2026-06-presence-continuity.md` | Phases 1 & 3 shipped; Phase 4 pending | Established stays persist across sparse-data days via `presence_log`; Phase 4 retires sleep inheritance |
| `2026-07-verified-core-lean.md` | port finished (#975) | The argument for the Lean core. Kept because the HSMM modules cite its reasoning; the seam is `docs/design/lean-and-rust.md` |
| `2026-07-osm-into-lean.md` | superseded by the ask protocol (#1709) | Kept for the buffer-sizing and line-metric measurements the code cites |

Retired on 2026-09-25, their durable parts folded into `docs/design/`: the Lean
port roadmap and the deterministic-fixtures design (the port is finished, the
fixtures are the corpus), the Google Health migration
(`docs/design/google-health.md`), and the learned-emissions pipeline
(`probabilistic-principles.md`, the to-add list). Git history has the text.

Shipped work that used to have a proposal here now lives in
`docs/design/` — the HSMM/joint-sequence decode shell, the
generator/scorer split, and the route-aware retirement are in
`probabilistic-principles.md`; the three-tier `ts_utc` schema is in
`timezone.md`; conflated-place splitting and the focus-place
weighting lessons are in `overview.md`; the pedestrian smoother and
the `smoothed` geometry kind are in `episode-geometry.md`. The earlier
2025 model docs were retired with the monorepo split (2026-07-05) and
live only in git history — there is no `docs/archive/` in this repo.

**Read `docs/design/probabilistic-principles.md` before adding new
factors, tuning parameters, or proposing alternatives.** It is the
contract behind these proposals: the philosophy (probabilistic
constraint solver, not heuristic stack), the rules (no hard
constraints in *scoring* — they belong in the *generator*; graduated
probabilities; offline precompute; do it right, not MVP-shortcut), and
the current factor library.

Rail-snap shipped 2026-05-18 (station-anchored, offline-precomputed) — its proposal was retired into `docs/design/rail-snap.md`.
