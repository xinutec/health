# Lean port roadmap — what remains to move from TS to Lean

Goal: almost everything algorithmic in Lean; TS (later Rust) is a thin shell doing
I/O, DB, HTTP, external APIs, and the parse/tz/topology boundary Lean genuinely
cannot do. Rust replaces the TS shell only at the very end, once the Lean surface
is broad enough that the shell is just glue.

Classification below is grounded in an import trace of the served path (routes →
decode-day/velocity) done 2026-07-24, not names alone. Line counts are current.
Items marked *(check)* need a file read to confirm serve-path membership or
overlap with an existing Lean core before porting.

## Measured state — run the tool, do not trust the list below

    nix develop . --command node scripts/lean-port-coverage.mjs [--all]

**The Tier list below is a plan, not a status, and it has drifted.** On 2026-07-29
it still called `kalman.ts` "the single best next port" while
`Verified/Geo/Kalman.lean` had been complete and `#guard`-pinned for some time —
following it would have meant re-porting finished work. A hand-kept inventory of
~60 modules cannot stay honest; measure instead.

As measured 2026-07-29, of 39 algorithm-layer files: **15 written, 14 partial,
10 absent**. Caveats that keep those numbers honest in BOTH directions:

- The tool matches *names*, not behaviour. `#guard` counts are the real evidence
  — they run inside `lake build`, so a divergence fails the build.
- It cannot tell algorithm from orchestration, so it OVERSTATES the gap. Several
  "missing" names belong in the shell for good: `loadBiometrics` / `computeVelocity`
  (DB/IO), `setSimplifyHook` (hook plumbing), `localHourOf` /
  `utcSecondsToDatetimeStr` (tz boundary), `stationsOnLine` (cache),
  `scheduleRailRouteFill` (IO).

**Written is not served, and serving is now the bottleneck.** Writing Lean changes
nothing on its own: the code has to reach a request through a `verified_cli` verb,
a tenant in `src/lean/`, and a flag. The entire serve surface today is

| flag | what executes |
|---|---|
| `LEAN_HSMM` | the HSMM decode |
| `LEAN_MATCH` | the walk map-matcher |
| `LEAN_RAIL` | rail shortest-path |
| `LEAN_PASSES` | five display-geometry helpers — simplify, spurs, spikes, trim, despike |

Everything else is written-but-idle. The next slices are therefore *execution*
slices — take a complete module, give it a CLI verb and a shadow tenant,
validate on the golden corpus, flip — not new ports. `Verified.Geo.Kalman`
(`filterGpsTrack` + `classifyMode`, 10 guards) is the obvious first: upstream of
everything, pure over the track, no OSM or DB.

## Already in Lean (done — do not port)

- **HSMM decode subsystem** (2026-07): observation tensor, gps-outliers,
  state-space, all scoring factors (emissions, transitions, duration, entry,
  initial, geometric, line-proximity, route-rail, chain-context, segment-evidence,
  train-generator, train-hop-duration), train-candidate generator + coverage,
  model assembly (`buildHsmmModel` twin), quantize + `PData` build, trellis
  (`pDecodeFast`). Self-contained `verified_cli assembledecode`; bit-identical to
  TS on all 11 golden days.
- **Walk map-matcher core** (`Verified.Geo`): simplify, corridor, graph,
  candidates, match-viterbi. Served via `LEAN_MATCH`.
- **Rail shortest-path** (`Verified.Rail`): certified Dijkstra.

## Off the served path — do not port (eval / training / legacy)

- Train-journey cluster (used only by eval/CLI, not serve): `route-aware-decoder`
  (457), `station-chain` (820), `tube-journey-assembler` (420),
  `inner-viterbi-edges` (372), `hsmm-marginals` (267), `mode-class-lock` (157).
- `fit-emissions` (241) — learned-emissions training; null in prod.
- `src/eval/*` (16 files) — offline scoring/evaluation, except
  `worldline-feasibility` (below), which the serve path imports.

## Shell — stays TS, becomes Rust last (do not port to Lean)

- OSM ingest: `osm`, `osm-local`, `osm-adapter*`, `osm-overpass*`, `osm-corridor`,
  `osm-rail-stops`, `osm-route-members`, `osm-bus-routes`.
- Data/DB: `src/db/*`, `route-graph-loader`, `*-cache`, `load-classification-inputs`,
  `hmm/persist`, `sleep/load`.
- Boundary Lean can't cross: `timezone`, `fitbit-tz` (IANA tz), `route-graph` (WKT +
  `nodeKey` topology), `opening-hours` (string parse).
- Lean bridge / shadow harness: `src/lean/*`, `walk-shadow-core`, `match-twin`,
  `quant-twin`, `hmm/lean-shadow-core`.
- Server / integrations: `src/routes/*`, `src/middleware/*`, `src/nextcloud/*`,
  `src/google/*`, `src/fitbit/*`.

## To port to Lean — the list

### Tier 1 — upstream, self-contained, high leverage
- `geo/kalman.ts` (316) — GPS Kalman filter. Feeds the observation tensor; pure
  numeric; no graph/tz. The single best next port.
- `geo/gps-quality.ts` (173) — per-fix GPS quality scoring.
- `geo/rail-road-proximity.ts` (127) — road/rail proximity per minute (produces the
  decode's `roadDistM`/`railDistM`).

### Tier 2 — post-decode journey / segment geometry (serve-path core)
- `geo/velocity.ts` (1914) — leg/journey measurement, the post-decode hub. Large;
  read + decompose into several Lean modules first.
- `geo/segments.ts` (936), `geo/segment-util.ts` (111), `geo/enriched-segment.ts` (88)
  — segment construction.
- `geo/stay-split.ts` (1283), `geo/dwell-continuation.ts` (177),
  `geo/inferred-stay.ts` (54), `geo/current-place.ts` (78) — stay logic.
- `geo/episode-geometry.ts` (380), `geo/interchange-split.ts` (346) — episode /
  interchange geometry.
- `eval/worldline-feasibility.ts` — feasibility check imported by velocity.
- `hmm/place-override.ts` (271) — place override (imported by velocity).

### Tier 3 — walk / road geometry *(check overlap with `Verified.Geo`)*
- `geo/walk-smooth-map.ts` (1345), `geo/walk-building-escape.ts` (1105),
  `geo/walkable-route.ts` (258), `geo/pedestrian-match.ts` (122),
  `geo/pedestrian-match-annotate.ts` (543), `geo/road-match.ts` (91),
  `geo/road-match-annotate.ts` (125). Some may already be covered by the Lean
  walk-matcher; audit before porting.

### Tier 4 — classification / evidence
- Biometrics: `geo/biometrics.ts` (565), `geo/mode-biometrics.ts` (502),
  `geo/biometric-coherence.ts` (72), `geo/bridge-stays-biometrics.ts` (179).
- Rail geometry: `geo/rail-snap.ts` (566), `geo/rail-route-fill.ts` (215),
  `geo/underground-rail.ts` (455), `geo/line-stations.ts` (390).
- Bus: `geo/bus-route-match.ts` (355), `geo/bus-evidence.ts` (285).
- Place / venue: `geo/venue-prior.ts` (637), `geo/place-prior.ts` (287),
  `geo/place-snap.ts` (105), `geo/focus-places.ts` (722),
  `geo/focus-places-identity.ts` (125), `geo/transit-place.ts` (133).

### Tier 5 — sleep + misc
- `sleep/day-state.ts` (269), `sleep/known-place-stays.ts` (147).
- `infer/day-grammar.ts` (128).
- Small serve-path helpers: `hmm/continuity-context.ts` (46),
  `hmm/place-reachability.ts` (74), `hmm/served-stations.ts` (76).

## Method (per port)

Follow the decode playbook: port to a `Verified.*` module in Lean `Float`, pin each
piece with `#guard` against Node/V8 values, then a shadow harness comparing the Lean
path to the TS one on real days. Exact for sqrt/arith/discrete; `approx` (≤1 ULP)
where sin/cos/atan2/log/exp/hypot enter. Keep the tz/WKT/topology boundary shell-side.
