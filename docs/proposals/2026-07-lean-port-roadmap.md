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
| `LEAN_BIOLABELS` | four biometric label-rewrite passes, five call sites (#390, 2026-07-30) |

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
- **And getting off `Float` ENDS the regime that currently proves the port.**
  Worth stating before it is discovered mid-migration. Every check the port has
  today — 33/33 SHELL ONLY on the day gate, the tenant ledgers, every `#guard` —
  asks the same question: *does Lean produce the bytes TS produced?* You cannot
  be byte-identical to a `Float` implementation without `Float`. So the day the
  reals go in, parity-with-TS stops being the criterion and something has to
  replace it: theorems for what can be proved, a stated tolerance for what
  cannot, and a decision about which served fields are allowed to move.

  That is a change of correctness regime, not a refactor, and it is in tension
  with "port as much as possible" only in the sense that the two want doing in a
  deliberate order. Porting under bit-identity first is the cheap direction: it
  is a mechanical check that catches real mistakes, and it is exactly what makes
  a later `Float` removal reviewable — you will have a byte-exact baseline to
  measure the intended deviation against, which you do not get if both changes
  land together.

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

### The third slice: decision-shaped, not just selection-shaped (#390)

`Verified.Geo.BiometricLabels` — the four velocity passes where the step counter
overrules GPS (`cadenceCorrect`, `revertIsolatedCadence`, `jitterWalkToStay`,
`walkThrough`) — extends the exact-gate class in a way worth naming, because it
is not selection-shaped. It *returns new values*. It still gets an exact gate,
because those values are **discrete**: a mode label, a run index, a `toFixed`
rendering. The generalisation is therefore

> what admits an exact gate is a pass whose output is drawn from a countable
> set the two runtimes can both name — not merely one that returns a subset.

Four passes rode one flag. That was deliberate: they are one port of one TS
module sharing every threshold, so splitting them would have bought four soaks
of the same surface. Five CALL SITES, though —
`revertIsolatedCadenceDrives` runs twice, once before the rail annotators exist
and once after, because a flip sandwiched between two underground legs only
looks isolated once those legs are labelled `train`. Both are served; wiring
only the first would have left production running TS at a pass the flag claims.

Three things made this slice cheap, and all three are reusable:

- **The dependency was already ported.** `BiometricWindows` had
  `cadenceForSegment` / `peakCadenceForSegment` with 43 guards. Prefer a slice
  whose callees are already standing.
- **`Verified.JsNum.toFixed` already existed** (61 guards), implementing the
  ECMA-262 rule against the double's exact binary value. The reason strings
  embed `cadence.toFixed(0)` and `linearity.toFixed(2)`, so without it the
  strings would have been the port's weakest point instead of a non-issue.
- **Decisions cross the wire, not records.** The Lean returns a verdict per
  segment and the shell rewrites the record — the same split as `bridgeStayRuns`.
  The port cannot drift on fields it does not model, and the comparison asks the
  only question that matters: did both arms decide the same thing?

Corpus evidence: `npm run golden` under `LEAN_BIOLABELS=on` is 32/32
byte-identical with the ledger reading `128/0f EXACT` — 32 days × 4 passes,
every call served, zero failures, zero divergences.

**One gate defect this slice found and fixed.** `golden-check` printed no Lean
ledger at all, so a green 32/32 was read from SILENCE — and silence is exactly
what a bridge that failed and fell back also produces, since both `shadow` and
`on` swallow `LeanBridgeError`. It now prints all three tenants' ledgers, so the
gate reports a call count instead of an absence.

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

**But a guard is a SNAPSHOT, so it is blind to the TS moving.** It records what
V8 answered on the day the port was written; it keeps passing while the function
it ports changes underneath. That is not a hypothetical — `pickBestStation` went
stale against the #373 fix with its guards green (#417), and the underground trio
was five commits behind before a real day aborted the fold (#425). Both were
found by reading or by luck, which is what a check is supposed to replace.

So the three kinds of evidence fail differently and only one of them notices
drift. `lean/experiments/lean-coverage.mts` labels them by that blind spot:

| | check | misses |
|---|---|---|
| live comparator | a gate replays real days through both arms | branches no real day takes |
| guard-pinned | `#guard`s in `lake build` | the TS moving (#417) |
| proven | a theorem in `lake build` | nothing it states |

Measured 2026-08-05: 120 modules live-compared, 5 guard-pinned, 2 proven, 0
unchecked — and after the focus gate landed the same day, **122 / 3 / 2 / 0**.
Read "guard-pinned" as *this port is unattended*, not as *this port is
nearly covered* — the five were `CurrentPlace`, `FocusIdentity`, `FocusPlaces`,
`LineStations`, `OsmSpatial`. What they have in common is not one caller: two of
them (`FocusPlaces`, `FocusIdentity`) are the weekly mining cron, `CurrentPlace`
is the `/internal` presence route, and the other two are read from inside larger
passes. The common property is that **no golden-day replay enters them**, which
is the thing that makes a day gate blind — not which cron they happen to sit on.
`FocusPlaces` and `FocusIdentity` moved to live-compared later the same day
(#435, below); the remaining three are still unattended.

A proof module has no comparator BY CONSTRUCTION — there is no TS arm to run
against a theorem — so counting it as uncovered says the best-evidenced file in
the tree is the least. `Verified.Geo.LazyLower` is 8 theorems and zero
definitions.

Derive expectations from V8, never by hand: `lean/experiments/*-refs.mts` runs
the real TS and prints the guard lines to paste. Each pinned module CITES its
harness by path in its docstring, and that citation is the provenance record —
`lean-coverage.mts` reads it and flags a citation whose file is gone. Do not try
to recover the link by searching harnesses for the Lean module name: a harness
imports its subject by TS filename and exported function and never names the Lean
module, so that search reports V8-derived guards as hand-written (#434). What the port owes is fidelity
to what TS does, including where that is odd — `impliedSpeedKmh` returns 0 for a
non-increasing `dt`, so a teleport sharing its anchor's timestamp is invisible
to the filter. That is TS's documented choice; the guard pins it rather than
quietly improving on it.

### The focus gate, and what a mutation sweep says about a gate (#435)

`pnpm run focus-gate` (`src/cli/compare-focus.ts` + the `focus` mode on
`verified_cli`) is the second live comparator, and it exists because the day
gate reaches everything `computeVelocity` runs and nothing the weekly
`refresh-focus-places` cron runs. It replays each golden day's PhoneTrack fixes
through `detectFocusPlaces`, then the whole corpus at once, then the captured
conflated café/residence cluster through `splitCluster`. 35 cases, 8 s.

**Concatenating the days is what makes it a check of the classification layer.**
Per-day runs reach three labels (`hotel`, `one-off`, `other`). The corpus run —
33.4k deduplicated fixes over a 93.8-day span — reaches `home`, `work`, `hotel`,
`other`, `one-off` and all three display-name tiers. `home` wants a 30-day span
and 20 distinct days, so no single day can produce it: without the corpus case
the two arms would have agreed on `one-off` and that agreement would have meant
nothing.

**A gate is worth what its ablation says it is worth.** 31 single-change
mutations of the Lean arm; **25 fire**. The sweep is
`lean/experiments/focus-mutation-sweep.mts` (#436) — it is the evidence for this
section and it is re-runnable, so the numbers below can be re-derived after the
next change to either arm rather than cited from here.

The six that do not fire are each measured rather than assumed, and **none of
them is a hole in the gate**: every one that can be characterised is a property
of the corpus, which no gate over this data could catch.

| silent mutation | why |
|---|---|
| `localSolarHourFractional` divisor 15 → 14 | TS arm ablated the same way is ALSO silent. The fractional variant feeds only `splitCluster`'s circular embedding, and 15 → 14 shifts the embedding by `|lon| · 60 · (1/14 − 1/15)` minutes — ~17 s per degree of longitude, so seconds for London clusters. That is far below the time-of-day separation a lobe split resolves. A fixture far from Greenwich would make it observable in BOTH arms. |
| long-running-`work` fraction 0.35 → 0.05 | TS arm also silent — the conjuncts beside it decide first. |
| `KMEANS_MAX_ITERS` 50 → 1 | TS arm also silent: Lloyd converges within one pass on every `splitCluster` call this corpus makes. |
| `matchClusters` taken-check dropped | TS arm also silent: the corpus contains no MERGE (two old clusters competing for one new), the shape that check exists for. |
| Fitbit overlap `>` → `≥` | provable no-op — at equality the added term is zero. No twin needed, and none can exist. |
| `matchClusters` tiebreak reversed | needs an EXACT float distance tie, which re-mined real centroids do not produce. Guard-only by construction. |

**Thirteen of the 31 never reached the gate — the module's own `#guard`s failed
`lake build` first.** That is the two layers being complementary rather than
redundant, and it is also a measurement hazard: a sweep that stops at
BUILD-FAILED is measuring the guards, not the gate. So the harness strips the
guard block before every Lean probe, and runs a CONTROL that strips the guards
and changes nothing else — it must read silent, or every verdict beside it is
unreadable, and the run aborts if it does not.

**A silent Lean probe is not a finding until its TS twin has been run.** The
first version of this table called the `localSolarHourFractional` divisor "the
one real gap", on the reasoning that the same change to `localSolarHour` fires.
That was an inference across two different functions, not a measurement:
mutating TS's `localSolarHourFractional` identically leaves the gate green too.
The harness now runs the twin automatically for any SILENT Lean probe, which is
what corrected it — and it is why the sweep belonged in the repo instead of the
scratch directory it was written in.

**Two of the original probes were wrong before the results were.** One pair of
"same" mutations hit different functions in the two languages (`localSolarHour`
lives in `Verified/Geo/Velocity.lean`, `localSolarHourFractional` in
`FocusPlaces.lean`); and one TS ablation patched `focus-places.js` when its
subject lives in `focus-places-identity.js`. Both read as findings about the
gate until they were checked. The harness now fails any anchor that does not
occur exactly once, which makes that particular mistake unrepresentable. When a
Lean and a TS probe of "the same constant" disagree, suspect the probes before
the arms.

`pickWinningAmenity` is the one export the gate does not reach: its input is a
vote tally over OSM venue names, so feeding it means carrying another module's
oracle and a fabricated tally checks nothing. It stays guard-pinned, and
`lean-coverage.mts` counts it that way rather than crediting it here.

### All four layers of a bridge call, separated (#433)

`lean/experiments/day-arm-cost.mts` now cuts the `day` tenant at every seam
#405 named, via three ablation handlers in `serveLoop`:

| handler | includes |
|---|---|
| `noop` | request wire |
| `daydecode` | + the typed decode (`dayResult`'s parse prefix, then stop) |
| `dayresp` | + the algorithm (the whole chain, returning counts not rows) |
| `day` | + the response side |

Measured over 33 golden days: **request wire 9.4 s (45%), typed decode 8.1 s
(39%), response wire 0.7 s (3%), ALGORITHM 2.6 s (13%)** of a 20.8 s fold. So
**87% of the fold is staging the Rust shell deletes** — the same figure #405
found on gpsquality, on a tenant three orders of magnitude larger, reached
independently.

**An ablation handler needs a forcing argument, and the argument must be
CHECKED.** `let (states, episodes) := dayChain chain` is a pure `let`: a handler
returning only `changed` would force the pass fold, have its `dayChain` call
eliminated as dead code, and report a duration for a chain that never ran. That
reads as a cheap algorithm — the direction that flatters the port, and nothing
in the timings would look wrong. So `dayresp` returns integer checksums that the
harness recomputes from the full `day` reply; a chain that did not run is a
mismatch, not a fast number. `daydecode` likewise must return a count, because
an errored handler returns fast and would read as a cheap decode.

**A premise written into the task was refuted by the measurement it asked for.**
It said "a multi-megabyte reply is not free". The request averages 2.41 MiB of
lookup tables; the reply is 0.11 MiB of the day's own rows. That asymmetry is
why layer 2 is a few milliseconds — and on 5 of 33 days it comes out NEGATIVE,
inside the noise. The harness prints that count rather than clamping it, because
a clamp turns a sampling artefact into a measurement.

**Quote the split, not the ratio.** `ts_net` is remeasured live every run, so the
arm ratio moved 3.23× → 2.72× → 3.09× across runs on the same code. The layer
percentages barely moved. The ratio is an order of magnitude; the split is the
result.
