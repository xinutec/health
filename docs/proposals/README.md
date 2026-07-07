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
| `decoder-roadmap.md` | active | **The single forward plan for the decoder line of work.** Move the day's reconstruction into one joint probabilistic decoder that owns a continuous map-matched worldline — physical feasibility is a property of the hypothesis space, not a post-hoc pass. Covers the quality bar, the generator/scorer architecture, the measurement prerequisite (#250), and Phases 0–5 (#257) |
| `geometry-roadmap.md` | active | **The single forward plan for the positioning/geometry line of work.** Draw a moving leg as the MAP estimate of one robust energy fusing GPS, physics, the map as a soft field, endpoint anchors, and the pedometer budget — replaces five converged proposals (true-path-reconstruction, map-constrained-positioning, continuous-field, joint-mode-position, robust-outlier-smoother; full text in git history). Covers the two measured phantom classes, the `WALK_RECON` swap, Phases G0–G4, and the measured landmines |
| `2026-06-magnetic-focus-places.md` | shipped; Phase 3 deferred | Place attribution as a stateful pull from focus_places, not a per-segment pick. Strong recurring places anchor noisy-GPS attribution against geometrically-close generic OSM POIs. Phase 3 (magnet on unmined locations) remains |
| `2026-06-presence-continuity.md` | partly shipped | Temporal extension of the magnet: established stays persist across sparse-data days via a `presence_log`, with confidence decay. Phases 1 & 3 shipped; Phase 4 (sleep-inheritance retirement) pending |
| `2026-05-scored-classification.md` | active | Replace the rule-cascade with factor-decomposed scoring + commute-history prior. Most phases shipped; the factor scorer is the per-minute scoring layer of the decoder architecture |
| `2026-05-hmm-learned-emissions.md` | partly shipped | Per-mode emission distributions fit from heuristic labels; supervised-learning pipeline lives at #208 |
| `2026-06-deterministic-fixtures.md` | design (revised) | Deterministic, zero-DB fixtures for the classification pipeline via an adapter pattern over unbounded sources (OSM, Fitbit, PhoneTrack); the `npm run golden` replay harness |
| `2026-06-google-health-migration.md` | deferred | Fitbit Web API → Google Health API migration ahead of the Sep 2026 sunset (#260). Weight slice shipped; bulk deferred |

Shipped work that used to have a proposal here now lives in
`docs/design/` — the HSMM/joint-sequence decode shell, the
generator/scorer split, and the route-aware retirement are in
`probabilistic-principles.md`; the three-tier `ts_utc` schema is in
`timezone.md`; conflated-place splitting and the focus-place
weighting lessons are in `overview.md`; the pedestrian smoother and
the `smoothed` geometry kind are in `episode-geometry.md`. The earlier
2025 model docs are in `docs/archive/`.

**Read `docs/design/probabilistic-principles.md` before adding new
factors, tuning parameters, or proposing alternatives.** It is the
contract behind these proposals: the philosophy (probabilistic
constraint solver, not heuristic stack), the rules (no hard
constraints in *scoring* — they belong in the *generator*; graduated
probabilities; offline precompute; do it right, not MVP-shortcut), and
the current factor library.

Rail-snap shipped 2026-05-18 (station-anchored, offline-precomputed) — its proposal was retired into `docs/design/rail-snap.md`.
