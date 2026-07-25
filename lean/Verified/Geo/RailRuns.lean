import Verified.Hsmm.FloatScore
/-!
# Rail-run leaves (port of the pure functions in `src/geo/passes/rail-runs.ts`)

Three helpers the rail-run annotator uses to decide where a ride began and
ended, and what to call the line it ran on. The surrounding
`annotateRailRuns` orchestration is async (station and line lookups against
OSM) and stays shell; these are its pure decisions.

* `findBoardingPlatformFix` — walk backwards from the first train-speed fix to
  the platform the rider actually boarded from.
* `findRunAlightFix` — walk forwards to the first sustained slow fix, stepping
  past mid-ride station dwells.
* `expandTubeLineNames` — one OSM line name → the physical lines it denotes.

## `expandTubeLineNames` is a THIRD line-name canonicaliser, not a duplicate

`Verified.Hsmm.RouteGraph.parseLineMemberships` (from `route-graph.ts`) does a
similar job and the two are NOT interchangeable:

* that one REQUIRES a `" Line"`/`" Lines"` suffix and returns the empty set
  without one; this one falls back to the input unchanged, so `"Bakerloo"` maps
  to `["Bakerloo"]` here and to `[]` there;
* that one strips a directional by matching a fixed list of `" Eastbound"`-style
  suffixes; this one uses `\s+(?:East|West|North|South)bound$/i`, so it also
  strips `"Line EASTBOUND"` and `"Line   Westbound"`;
* a combined name that splits into only ONE part returns the BASE here
  (`"Solo Lines"` → `["Solo Lines"]`, not `["Solo Line"]`) — the TS guards on
  `parts.length > 1`.

All three differences are guarded below.

Exactness: every decision is exact; `haversineMeters` (atan2) puts the platform
cluster's spread test at ≤ 1 ULP. UNPROVEN; pinned against Node/V8
(`lean/experiments/rail-runs-refs.mts`).
-/

namespace Verified.Geo.RailRuns

open Verified.Hsmm.FloatScore (haversineMeters)

structure Fix where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  deriving Inhabited, BEq, Repr

/-! ## `expandTubeLineNames` -/

/-- The four compass words, lower-cased for a case-insensitive suffix test. -/
private def DIRECTIONAL_WORDS : List String := ["eastbound", "westbound", "northbound", "southbound"]

/-- Strip a trailing `\s+(?:East|West|North|South)bound`, case-insensitively,
then trim. The leading `\s+` is REQUIRED, so a name that simply ends in the
letters (no separating space) keeps them. -/
private def stripDirectional (s : String) : String :=
  let lower := s.toLower
  match DIRECTIONAL_WORDS.find? (fun w => lower.endsWith w) with
  | none => s.trimAscii.toString
  | some w =>
    let head := (s.dropEnd w.length).toString
    match head.toList.getLast? with
    | some c => if c.isWhitespace then head.trimAscii.toString else s.trimAscii.toString
    | none => s.trimAscii.toString

/-- `\s+and\s+` at the head of `cs`: the remainder after it, or `none`. -/
private def andSeparator (cs : List Char) : Option (List Char) :=
  let ws := cs.takeWhile Char.isWhitespace
  if ws.isEmpty then none
  else
    let afterWs := cs.drop ws.length
    if afterWs.take 3 == ['a', 'n', 'd'] then
      let afterAnd := afterWs.drop 3
      let ws2 := afterAnd.takeWhile Char.isWhitespace
      if ws2.isEmpty then none else some (afterAnd.drop ws2.length)
    else none

/-- Split on `/,\s*|\s+and\s+/`. The alternation is tried left to right at each
position, so a comma wins over an `and` starting at the same index. Fuel-bounded
by the input length rather than `partial`. -/
private def splitParts : Nat → List Char → List String
  | 0, _ => [""]
  | _, [] => [""]
  | n + 1, c :: rest =>
    if c == ',' then "" :: splitParts n (rest.dropWhile Char.isWhitespace)
    else match andSeparator (c :: rest) with
      | some tail => "" :: splitParts n tail
      | none =>
        match splitParts n rest with
        | [] => [String.singleton c]
        | head :: tail => (String.singleton c ++ head) :: tail

/-- Canonicalise one OSM rail-line name into the physical lines it denotes, so a
board∩alight intersection can resolve a unique line despite OSM's inconsistent
naming. Two quirks are handled:

1. **Direction split** — a line's two directions are separate relations
   ("Victoria Line" vs "Victoria Line Northbound"). Strip the compass word.
2. **Shared-track combine** — lines sharing track are tagged under one relation
   ("Circle, Hammersmith & City and Metropolitan Lines") while the same line is
   plain elsewhere. Split and re-suffix each component. `&` is NOT a separator,
   so "Hammersmith & City" stays whole.

A plain singular name — or anything that does not split into two or more parts —
returns itself. -/
def expandTubeLineNames (name : String) : List String :=
  let base := stripDirectional name
  if base.endsWith " Lines" then
    let inner := (base.dropEnd " Lines".length).toString
    let parts := (splitParts inner.length inner.toList).filterMap fun p =>
      let t := p.trimAscii.toString
      if t.isEmpty then none else some t
    if parts.length > 1 then parts.map (· ++ " Line") else [base]
  else [base]

/-! ## `findBoardingPlatformFix` -/

/-- How far back from the classifier's start to look for the platform. Sized for
a multi-station tube ride whose opening got classified as walking because the
per-station stops dominated the window median. -/
def PLATFORM_PATTERN_WALKBACK_S : Int := 900
/-- At or below this the user is STANDING on the platform, not still walking
towards it. The backward chain walks through these only, stopping at the first
walking-pace fix — that is what separates the platform-wait cluster from an
approach walk past a nearer station. -/
def BOARDING_STILL_KMH : Float := 3
/-- At or above this the train is clearly in motion. -/
def PLATFORM_TRAIN_KMH : Float := 30
/-- Longest gap between consecutive slow fixes still in the same platform chain.
Walking to a different station leaves a gap of minutes. -/
def PLATFORM_MAX_GAP_S : Int := 180
/-- How far the platform cluster may spread before it is a different place. -/
def PLATFORM_MAX_SPREAD_M : Float := 150

/-- The platform fix a ride actually boarded from, or `none`.

Two phases, and the split matters. The platform-train-platform pattern has
ACCELERATING fixes (walking-pace, 4-8 km/h) between the platform and the first
train-speed fix, so phase one walks back PAST those to find the first
near-stationary fix — the anchor. Phase two then extends further back through
more near-stationary fixes, bounded by time gap and cluster spread; the first
walking-pace fix ends the chain, because further back the user was still
approaching. The EARLIEST fix in the chain is the boarding anchor.

`none` when the window holds no train-speed fix (the classifier's start is
already at or before the first train signal we have) or no near-stationary fix
before it. -/
def findBoardingPlatformFix (points : Array Fix) (startTs : Int) : Option Fix := Id.run do
  let windowStart := startTs - PLATFORM_PATTERN_WALKBACK_S
  let windowFixes :=
    ((points.filter fun p => p.ts ≥ windowStart && p.ts ≤ startTs).toList.mergeSort
      fun a b => a.ts ≤ b.ts).toArray
  if windowFixes.isEmpty then return none
  -- Phase zero: the earliest train-speed fix in the window.
  let mut firstFastIdx : Option Nat := none
  for i in [0:windowFixes.size] do
    if firstFastIdx.isNone && windowFixes[i]!.speedKmh ≥ PLATFORM_TRAIN_KMH then
      firstFastIdx := some i
  match firstFastIdx with
  | none => return none
  | some fastIdx =>
    let isStill (p : Fix) : Bool := p.speedKmh < BOARDING_STILL_KMH
    -- Phase one: walk back to the anchor, past the accelerating fixes.
    let mut anchorIdx : Option Nat := none
    let mut k := fastIdx
    while k > 0 do
      let i := k - 1
      let p := windowFixes[i]!
      if windowFixes[fastIdx]!.ts - p.ts > PLATFORM_PATTERN_WALKBACK_S then break
      if isStill p then
        anchorIdx := some i
        break
      k := i
    match anchorIdx with
    | none => return none
    | some aIdx =>
      -- Phase two: extend back through the cluster.
      let anchor := windowFixes[aIdx]!
      let mut earliestIdx := aIdx
      let mut prevChainTs := anchor.ts
      let mut j := aIdx
      while j > 0 do
        let i := j - 1
        let p := windowFixes[i]!
        if !isStill p then break
        if prevChainTs - p.ts > PLATFORM_MAX_GAP_S then break
        if haversineMeters p.lat p.lon anchor.lat anchor.lon > PLATFORM_MAX_SPREAD_M then break
        earliestIdx := i
        prevChainTs := p.ts
        j := i
      return some windowFixes[earliestIdx]!

/-! ## `findRunAlightFix` -/

/-- Below this the ride is over — the loose post-transit bar. -/
def POST_TRANSIT_SPEED_KMH : Float := 15
/-- The preferred, tighter bar: a genuinely stopped fix. -/
def POST_TRANSIT_ALIGHT_SPEED_KMH : Float := 5
/-- A slow fix followed within this by a transit-speed fix is the train PAUSING
at a station, not the user getting off. -/
def MID_RIDE_DWELL_RESUME_S : Int := 120

/-- The fix at which a ride ended.

Walks past mid-ride dwells: the alight is the first slow fix that is NOT
followed within 120 s by a return to transit speed. Three arms, in preference
order — under 5 km/h, then under 15, then simply the first fix after the ride's
end (the ride ran off the end of the data). Fixes at or before `endTs` are
skipped entirely. -/
def findRunAlightFix (points : Array Fix) (endTs : Int) : Option Fix :=
  let findSustained (pred : Fix → Bool) : Option Fix :=
    (points.filter fun p => p.ts > endTs && pred p).find? fun p =>
      let cutoff := p.ts + MID_RIDE_DWELL_RESUME_S
      !(points.any fun q => q.ts > p.ts && q.ts ≤ cutoff && q.speedKmh ≥ POST_TRANSIT_SPEED_KMH)
  (findSustained fun p => p.speedKmh < POST_TRANSIT_ALIGHT_SPEED_KMH).orElse fun _ =>
    (findSustained fun p => p.speedKmh < POST_TRANSIT_SPEED_KMH).orElse fun _ =>
      points.find? fun p => p.ts > endTs

/-! ## Guards (V8 reference values) -/

private def pi : Float := 3.141592653589793
private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
/-- `n` metres north of the frame origin. -/
private def north (n : Float) : Float × Float := (lat0 + n * mlat, lon0)

#guard mlat == 0.00000898311174991017
#guard (north 200).1 == 51.52179662234999

private def fx (ts : Int) (speedKmh : Float) (metresNorth : Float := 0) : Fix :=
  { ts, lat := (north metresNorth).1, lon := (north metresNorth).2, speedKmh }

-- A plain singular name comes back as itself.
#guard expandTubeLineNames "Metropolitan Line" == ["Metropolitan Line"]
-- Directional suffixes are stripped, case-insensitively and through arbitrary
-- whitespace — a REGEX, not the fixed suffix list `parseLineMemberships` uses.
#guard expandTubeLineNames "Victoria Line Northbound" == ["Victoria Line"]
#guard expandTubeLineNames "Jubilee Line Eastbound" == ["Jubilee Line"]
#guard expandTubeLineNames "Jubilee Line EASTBOUND" == ["Jubilee Line"]
#guard expandTubeLineNames "Jubilee Line   Westbound" == ["Jubilee Line"]
-- Combined relations split on ", " and " and ", each part re-suffixed. `&` is
-- NOT a separator, so "Hammersmith & City" survives whole.
#guard expandTubeLineNames "Circle, Hammersmith & City and Metropolitan Lines"
  == ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
#guard expandTubeLineNames "Circle and District Lines" == ["Circle Line", "District Line"]
-- A combined name that splits into ONE part returns the BASE, suffix and all —
-- the `parts.length > 1` guard, so this is "Solo Lines", not "Solo Line".
#guard expandTubeLineNames "Solo Lines" == ["Solo Lines"]
-- The directional is stripped BEFORE the combine match.
#guard expandTubeLineNames "Circle and District Lines Southbound" == ["Circle Line", "District Line"]
-- No " Lines" suffix: returned as-is. `parseLineMemberships` returns EMPTY for
-- this same input — the difference that makes these two non-interchangeable.
#guard expandTubeLineNames "Bakerloo" == ["Bakerloo"]
#guard expandTubeLineNames "" == [""]
#guard expandTubeLineNames "  Central Line  " == ["Central Line"]
-- The `\s+` before the compass word is REQUIRED: a name that merely ENDS in
-- those letters keeps them.
#guard expandTubeLineNames "Eastbound" == ["Eastbound"]
#guard expandTubeLineNames "XEastbound" == ["XEastbound"]
-- `\s+and\s+` needs whitespace on BOTH sides, so the "and" inside "Grand" is
-- not a separator — a whitespace-optional rule would split "Gr" from
-- "Union and Lee".
#guard expandTubeLineNames "Grand Union and Lee Lines" == ["Grand Union Line", "Lee Line"]
-- …and it tolerates RUNS of whitespace, which a literal " and " split would not.
#guard expandTubeLineNames "Circle  and  District Lines" == ["Circle Line", "District Line"]
-- The TRAILING `\s+` matters too: "andDistrict" is one word, so this does not
-- split at all and keeps its suffix.
#guard expandTubeLineNames "Circle andDistrict Lines" == ["Circle andDistrict Lines"]

private def START_TS : Int := 10000

-- The platform-train-platform pattern: approach at walking pace, stand, then
-- accelerate. Phase one walks PAST the accelerating fix to the anchor, phase
-- two extends back, and the walking-pace approach ends the chain.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 800) 5 0, fx (START_TS - 700) 1 200, fx (START_TS - 640) 1 205,
      fx (START_TS - 580) 6 210, fx (START_TS - 520) 40 400] START_TS).map (·.ts) == some 9300
-- No train-speed fix in the window, and no near-stationary fix before one.
#guard findBoardingPlatformFix #[fx (START_TS - 700) 1 0, fx (START_TS - 600) 5 50] START_TS == none
#guard findBoardingPlatformFix #[fx (START_TS - 700) 10 0, fx (START_TS - 600) 40 300] START_TS == none
-- The chain breaks on a TIME GAP: 181 s is over the bar, 180 s exactly chains.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 900) 1 200, fx (START_TS - 719) 1 205, fx (START_TS - 660) 1 205,
      fx (START_TS - 600) 40 400] START_TS).map (·.ts) == some 9281
#guard (findBoardingPlatformFix
    #[fx (START_TS - 900) 1 200, fx (START_TS - 720) 1 205, fx (START_TS - 660) 1 205,
      fx (START_TS - 600) 40 400] START_TS).map (·.ts) == some 9100
-- …and on SPREAD: a still fix 200 m from the anchor is a different place.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 800) 1 0, fx (START_TS - 700) 1 200, fx (START_TS - 640) 1 205,
      fx (START_TS - 600) 40 400] START_TS).map (·.ts) == some 9300
-- A single platform fix, nothing to extend.
#guard (findBoardingPlatformFix #[fx (START_TS - 700) 1 200, fx (START_TS - 600) 40 400] START_TS).map (·.ts)
  == some 9300
-- Fixes outside the 900 s walkback are not in the window at all.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 901) 1 200, fx (START_TS - 700) 1 205, fx (START_TS - 600) 40 400] START_TS).map (·.ts)
  == some 9300
-- A fix at EXACTLY the train bar counts as in motion (`≥`); one at exactly the
-- still bar does NOT count as near-stationary (`<`), so there is no anchor.
#guard (findBoardingPlatformFix #[fx (START_TS - 700) 1 200, fx (START_TS - 600) 30 400] START_TS).map (·.ts)
  == some 9300
#guard findBoardingPlatformFix #[fx (START_TS - 700) 3 200, fx (START_TS - 600) 40 400] START_TS == none
#guard (findBoardingPlatformFix #[fx (START_TS - 700) 2.9 200, fx (START_TS - 600) 40 400] START_TS).map (·.ts)
  == some 9300
-- The walkback WINDOW bound in isolation: two platform fixes 101 s apart — well
-- inside the chain's gap tolerance — with the earlier one 901 s back. It is out
-- of the window entirely, so the chain starts at the later one.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 901) 1 200, fx (START_TS - 800) 1 200, fx (START_TS - 600) 40 400] START_TS).map (·.ts)
  == some 9200
-- Input order is irrelevant: the window is sorted by ts first.
#guard (findBoardingPlatformFix
    #[fx (START_TS - 600) 40 400, fx (START_TS - 640) 1 205, fx (START_TS - 700) 1 200,
      fx (START_TS - 800) 5 0] START_TS).map (·.ts) == some 9300
#guard findBoardingPlatformFix #[] START_TS == none

private def END_TS : Int := 20000

-- The preferred arm: the first fix under 5 km/h that stays slow.
#guard (findRunAlightFix #[fx (END_TS + 60) 40, fx (END_TS + 120) 2, fx (END_TS + 180) 2] END_TS).map (·.ts)
  == some 20120
-- A mid-ride station DWELL is walked past: slow, then transit speed again
-- inside 120 s, so the real alight is the later fix that stays slow.
#guard (findRunAlightFix
    #[fx (END_TS + 60) 2, fx (END_TS + 120) 40, fx (END_TS + 240) 2, fx (END_TS + 300) 1] END_TS).map (·.ts)
  == some 20240
-- A resume 121 s later is outside the window; 120 s exactly is inside (`≤`).
#guard (findRunAlightFix #[fx (END_TS + 60) 2, fx (END_TS + 181) 40] END_TS).map (·.ts) == some 20060
#guard (findRunAlightFix #[fx (END_TS + 60) 2, fx (END_TS + 180) 40, fx (END_TS + 300) 2] END_TS).map (·.ts)
  == some 20300
-- The tight arm is PREFERRED, not merely first: a 10 km/h fix precedes a 2 km/h
-- one and the 2 wins. Without this the two arms are indistinguishable.
#guard (findRunAlightFix #[fx (END_TS + 60) 40, fx (END_TS + 120) 10, fx (END_TS + 180) 2] END_TS).map (·.ts)
  == some 20180
-- SECOND arm: nothing under 5, but something under 15.
#guard (findRunAlightFix #[fx (END_TS + 60) 40, fx (END_TS + 120) 10, fx (END_TS + 180) 10] END_TS).map (·.ts)
  == some 20120
-- THIRD arm: nothing slow at all — the first fix after the end, whatever it is.
#guard (findRunAlightFix #[fx (END_TS + 60) 40, fx (END_TS + 120) 40] END_TS).map (·.ts) == some 20060
-- Fixes at or before `endTs` are skipped, including one exactly on it.
#guard (findRunAlightFix #[fx (END_TS - 60) 1, fx END_TS 1, fx (END_TS + 60) 2] END_TS).map (·.ts) == some 20060
#guard findRunAlightFix #[] END_TS == none

end Verified.Geo.RailRuns
