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
| `LEAN_KALMAN` | the GPS Kalman filter (#387, 2026-07-29) |
| `LEAN_GPSQUALITY` | the GPS quality pre-filter (#388, 2026-07-30) |

Everything else is written-but-idle. The next slices are therefore *execution*
slices — take a complete module, give it a CLI verb and a shadow tenant,
validate on the golden corpus, flip — not new ports.

### What the first execution slice cost, and what it taught (#387)

`Verified.Geo.Kalman` was the obvious first: upstream of everything, pure over
the track, no OSM or DB. Writing it was already done; serving it took a
transport and a measurement.

**Transport.** Every earlier mode quantises to the pinned 1e-7° grid before it
emits, so no Float ever crosses the wire. The Kalman filter cannot: it is a
covariance recursion over raw degrees. And `Lean.toJson (f : Float)` prints six
decimal places — `51.50009905063291` returns as `51.500099`, `1e-7` as `0` —
because `Lean.JsonNumber` is a decimal and Lean has no shortest-round-trip
printer (that is Ryu/Grisu, which `JsNum.lean` explicitly declines to port). So
Floats cross as IEEE-754 bit patterns in decimal STRINGS: a bare JSON integer
would hit JS's 2^53 limit and be re-rounded by `JSON.parse` one layer down.
`src/lean/float-bits.ts` + `fBits`/`jBits` in `Main.lean`. Reusable — any future
mode over unquantised reals wants it.

**Measurement, and a bar that had to move.** The plan said the flip bar was
bit-exactness: same arithmetic, same bits, so equal output. The corpus refuted
that. `lon` differs on ~0.5% of rows by ≤1 ULP; the cause, measured over inputs
carried as exact bits, is that this Lean runtime's `Float.cos` and V8's
`Math.cos` disagree by 1 ULP on 7.6% of real latitudes. `metersToDegreesLon`
calls `cos`; `metersToDegreesLat` does not, and `lat` is bit-identical on every
day — the controlled comparison that makes the attribution solid.

Two consequences for the rest of the port:

- **Expect this wherever `sin`/`cos`/`atan2`/`log`/`exp` enter, and set the bar
  accordingly.** Bit-exactness is the right bar for discrete and
  quantised-input modes (`geo`, `match`, `rail`, the HSMM decode — all of which
  achieve it). For a mode over unquantised reals with transcendentals it is
  unreachable, and demanding it would either block the flip forever or teach the
  reader to ignore the ledger. `lean-kalman`'s ledger therefore reports a ULP
  magnitude and reserves the loud verdict for what no ULP story explains: the
  two arms keeping *different fixes*.
- **This is the concrete case for getting off `Float`.** Not a style preference
  — a fixed-point or rational metre↔degree scaling would agree exactly across
  runtimes AND be provable, where two IEEE `cos` implementations can never be
  made to agree. Every transcendental in the served path is a place where the
  port can be pinned by testing but not proved.

### The second slice, and the shape worth preferring (#388)

`Verified.Geo.GpsQuality` — the incoherent-run pre-filter one call ABOVE the
Kalman filter — went in next and cost almost nothing: the bit transport already
existed, so it was a verb, a tenant, and a referee. `npm run compare-gpsquality`
reports **32/32 days agreeing exactly on the keep-set**, and golden under
`LEAN_GPSQUALITY=on` is 32/32 byte-identical with zero divergence warnings.

The contrast with Kalman is the lesson, and it should steer which modules get
served next. This filter is **drop-only**: every fix it emits is a *copy of an
input fix*, never a computed value. Inputs cross as exact bits, so both arms
select from bit-identical candidates and the output is pure selection; `cos`
reaches only the threshold comparisons. There is therefore no ULP class to
grade — any divergence at all is a DECISION flip, and the ledger has two levels
instead of three.

**Prefer selection-shaped modules when choosing the next slice.** A pass that
returns a subset of its input (the geometry passes, this filter, the rail path's
vertex indices) admits an exact gate on any runtime. A pass that returns freshly
computed reals (Kalman, and most of Tier 2/4) can only ever have a bounded-ULP
gate plus a structural invariant. Both are shippable; the first is far cheaper
to be confident about.

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

### Which gate can actually see your flag

A green gate that never executed the flag proves nothing, and the two ways to get
one are both easy to walk into.

**Wrong layer.** A velocity-layer flag can only be gated by a harness that enters
through `computeVelocity` / `computeVelocityFromInputs` — `npm run golden` and
`npm run walk-gate` (`score-walk-match.ts` calls it directly). `npm run
score-decoder` replays *captured* HSMM fixtures straight into `decodeHsmm` and
never enters velocity at all, so for `LEAN_GPSQUALITY` and `LEAN_KALMAN` it is
identical by construction. I had it on the #388 gate list; running it would have
been theatre. Decoder-layer harnesses gate decoder-layer flags.

**Silent fallback.** Both `shadow` and `on` swallow a `LeanBridgeError` and
return the TS result, so a gate can be green because the bridge never ran. The
positive signal is `lean-bridge: serving verified core` on stderr, with zero
`degraded` lines; check for it before reading anything into a pass.

### Guards vs the corpus — they fail differently

The corpus is real but it only covers the branches real days happen to take. 32
days of London never produced a null accuracy, a duplicate timestamp, or a
bridge scan running past its 30-minute horizon, so `GpsQuality` measured 32/32
exact with three of its branches untested. `#guard`s are the complement: they
run inside `lake build`, so a divergence fails the build rather than waiting for
a day that happens to exercise it. Write one per branch and per threshold
boundary — a pair straddling the boundary (80 vs 80.001) is what distinguishes
`>` from `≥`, and the two must NOT agree.

Derive expectations from V8, never by hand: `lean/experiments/*-refs.mts` runs
the real TS and prints the guard lines to paste. What the port owes is fidelity
to what TS does, including where that is odd — `impliedSpeedKmh` returns 0 for a
non-increasing `dt`, so a teleport sharing its anchor's timestamp is invisible
to the filter. That is TS's documented choice; the guard pins it rather than
quietly improving on it.
