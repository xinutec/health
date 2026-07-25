import Verified.Geo.UndergroundRun
/-!
# Underground interchange split (port of `reconstructUndergroundJourney`,
`src/geo/underground-rail.ts`)

A single coarse run can span an interchange: the cell-network fixes hug one
line, GPS briefly recovers on the platform at the changeover, then coarse fixes
hug the next line. No single line serves both ends, so
`reconstructUndergroundRun` alone returns `none` and the whole ride is lost (the
2026-06-28 Highbury & Islington → King's Cross [Victoria] → Wembley Park
[Metropolitan] return).

Strategy: try a single through-line first — the common case, unchanged. Only if
that fails, and a mid-run cluster of good fixes pins a plausible interchange, is
the run split there and each half reconstructed independently.

## The gate that stops a phantom change

Two legs are returned only when both halves resolve to real single-line journeys
AND agree on the interchange station AND pass a three-way disjointness test:
the two legs must be on genuinely different lines, and NEITHER end could have
ridden straight through on the other half's line.

That test compares PHYSICAL lines, not OSM relation strings, and the difference
is the whole point. OSM writes one line two ways — `"Metropolitan Line"` at one
station and `"Circle, Hammersmith & City and Metropolitan Lines"` at another — so
a raw string intersection sees nothing shared and would manufacture an
interchange on what was one continuous Metropolitan ride (2026-06-23 Wembley Park
→ Euston Square). Canonicalised through `expandTubeLineNames`, the two halves are
the same line and the split is refused. Two guards below are exactly that pair:
identical geometry, differing only in the line NAMES, one splitting and one not.

## What the guards do NOT pin, stated rather than implied

* `disjointLines l1 l2` (the first conjunct) can never be the SOLE refuser:
  `leg1.line ∈ boardLines`, so `l1 ⊆ expand boardLines`, and any overlap between
  the legs is therefore also an overlap with the board end. It is implied by the
  second conjunct.
* The station-agreement check is structurally always true (see the note at its
  site).
* The per-side `< MIN_COARSE_FIXES` check is redundant with the identical test
  inside `reconstructUndergroundRun`; removing it changes nothing observable.
* Three strictness choices have no input on the bar and so are unpinned: the
  cluster-span filter (`>` versus `≥` at exactly the first or last coarse
  timestamp), the cluster gap (`≤` versus `<` at exactly 300 s), and the
  `2 × MIN_COARSE_FIXES` split bar. The gap CONSTANT is pinned — a probe moving
  300 to 100 splits the merged cluster and fails.

UNPROVEN; pinned against Node/V8 (`lean/experiments/underground-journey-refs.mts`).
-/

namespace Verified.Geo.UndergroundJourney

open Verified.Geo.UndergroundRun
  (CoarseFix LatLon UndergroundRun isCoarse MIN_COARSE_FIXES reconstructUndergroundRun)
open Verified.Geo.RailRuns (expandTubeLineNames)
open Verified.Geo.TubeHop (NearbyStation)

/-- Longest gap between two recovered good fixes that still counts as ONE
platform cluster. Beyond it they are separate candidate interchanges. -/
def MAX_COARSE_GAP_S : Int := 300

/-- Group mid-run good fixes into platform clusters by time gap. Input must be
time-sorted; each cluster is contiguous within `MAX_COARSE_GAP_S`. -/
def clusterByGap (fixes : Array CoarseFix) : Array (Array CoarseFix) :=
  fixes.foldl (init := #[]) fun clusters f =>
    match clusters.back? with
    | some cur =>
      if f.ts - cur[cur.size - 1]!.ts ≤ MAX_COARSE_GAP_S then clusters.pop.push (cur.push f)
      else clusters.push #[f]
    | none => clusters.push #[f]

/-- The physical lines a set of OSM relation names denotes. -/
private def expand (names : Array String) : Array String :=
  names.foldl (init := #[]) fun acc n =>
    (expandTubeLineNames n).foldl (fun a x => if a.contains x then a else a.push x) acc

private def disjointLines (a b : Array String) : Bool := !a.any (b.contains ·)

/-- Reconstruct an underground journey as ONE or TWO line legs.

`interchangeFixes` are the well-located fixes that surfaced mid-run — the
platform at the changeover. Returns `#[]` when neither a through-line nor a
defensible split can be established; a spurious mid-run blip cannot manufacture
a phantom change, because both halves must resolve AND meet at one station AND
be on physically distinct lines. -/
def reconstructUndergroundJourney (fixes interchangeFixes : Array CoarseFix)
    (boardingFix alightingFix : LatLon)
    (stationsLookup : Float → Float → Array NearbyStation)
    (linesLookup : Float → Float → Array String) : Array UndergroundRun :=
  match reconstructUndergroundRun fixes boardingFix alightingFix stationsLookup linesLookup with
  | some single => #[single]
  | none =>
    let coarse := ((fixes.filter isCoarse).toList.mergeSort fun a b => a.ts ≤ b.ts).toArray
    -- Fewer than two legs' worth of coarse fixes cannot make two real legs.
    if coarse.size < 2 * MIN_COARSE_FIXES then #[] else
    let boardLines := linesLookup boardingFix.lat boardingFix.lon
    let alightLines := linesLookup alightingFix.lat alightingFix.lon
    -- Candidate interchanges: good-fix clusters STRICTLY inside the coarse span.
    let mid := ((interchangeFixes.filter fun f =>
      f.ts > coarse[0]!.ts && f.ts < coarse[coarse.size - 1]!.ts).toList.mergeSort
      fun a b => a.ts ≤ b.ts).toArray
    let clusters := clusterByGap mid
    let tryCluster (cluster : Array CoarseFix) : Option (Array UndergroundRun) :=
      let ixTs := cluster[cluster.size / 2]!.ts
      let n := Float.ofNat cluster.size
      let ixPt : LatLon :=
        ⟨cluster.foldl (· + ·.lat) 0 / n, cluster.foldl (· + ·.lon) 0 / n⟩
      let before := coarse.filter (·.ts < ixTs)
      let after := coarse.filter (·.ts > ixTs)
      if before.size < MIN_COARSE_FIXES || after.size < MIN_COARSE_FIXES then none else
      match reconstructUndergroundRun before boardingFix ixPt stationsLookup linesLookup,
            reconstructUndergroundRun after ixPt alightingFix stationsLookup linesLookup with
      | some leg1, some leg2 =>
        -- STRUCTURALLY ALWAYS TRUE, and no guard can catch its removal: leg1's
        -- alight station and leg2's board station are both
        -- `pickBestStation (stationsLookup ixPt)` — the same call at the same
        -- coordinate. A defensive assertion in the TS, kept for fidelity and so
        -- a future refactor that splits the two lookups does not lose it.
        if leg1.alightingStation != leg2.boardingStation then none
        else
          let l1 := expand #[leg1.line]
          let l2 := expand #[leg2.line]
          if disjointLines l1 l2 && disjointLines (expand boardLines) l2
              && disjointLines (expand alightLines) l1
          then some #[leg1, leg2] else none
      | _, _ => none
    (clusters.findSome? tryCluster).getD #[]

/-! ## Guards (V8 reference values) -/

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def north (n : Float) : LatLon := ⟨lat0 + n * mlat, lon0⟩
#guard (north 4000).lat == 51.55593244699964

private def fx (ts : Int) (metresNorth : Float) (accuracy : Option Float) : CoarseFix :=
  { ts, lat := (north metresNorth).lat, lon := (north metresNorth).lon, accuracy }

private def BOARD : LatLon := north 0
private def ALIGHT : LatLon := north 4000

private def stn (name : String) (distanceM : Float) : NearbyStation :=
  { name, subtype := "station", distanceM }

/-- Three station zones: below 1 km, 1-3 km, above 3 km. -/
private def stations (lat : Float) (_lon : Float) : Array NearbyStation :=
  let m := (lat - lat0) / mlat
  if m < 1000 then #[stn "Highbury & Islington" 40]
  else if m < 3000 then #[stn "King's Cross" 50]
  else #[stn "Wembley Park" 60]

/-- A genuine change: Victoria south, Metropolitan north, both at the platform. -/
private def changeLines (lat : Float) (_lon : Float) : Array String :=
  let m := (lat - lat0) / mlat
  if m < 1500 then #["Victoria Line"]
  else if m < 2500 then #["Victoria Line", "Metropolitan Line"]
  else #["Metropolitan Line"]

private def COMBINED : String := "Circle, Hammersmith & City and Metropolitan Lines"
/-- The PARALLEL-CORRIDOR TRAP: one continuous Metropolitan ride under two OSM
names. Identical geometry to `changeLines`; only the strings differ. -/
private def sameLineTwoNames (lat : Float) (_lon : Float) : Array String :=
  let m := (lat - lat0) / mlat
  if m < 1500 then #["Metropolitan Line"]
  else if m < 2500 then #["Metropolitan Line", COMBINED]
  else #[COMBINED]

/-- THE BOARD-END CONJUNCT, isolated: the board end serves leg2's line under the
COMBINED name, so a raw-string single run still fails, but canonicalised the
rider could have stayed on one line. -/
private def boardEndCouldRideThrough (lat : Float) (_lon : Float) : Array String :=
  let m := (lat - lat0) / mlat
  if m < 1500 then #["Victoria Line", COMBINED]
  else if m < 2500 then #["Victoria Line", "Metropolitan Line"]
  else #["Metropolitan Line"]

/-- THE ALIGHT-END CONJUNCT, isolated: the mirror image. -/
private def alightEndCouldRideThrough (lat : Float) (_lon : Float) : Array String :=
  let m := (lat - lat0) / mlat
  if m < 1500 then #["Victoria Line"]
  else if m < 2500 then #["Victoria Line", "Metropolitan Line"]
  else #["Metropolitan Line", "Victoria and Bakerloo Lines"]

private def oneLine (_lat _lon : Float) : Array String := #["Victoria Line"]

private def COARSE : Array CoarseFix :=
  #[fx 1000 200 (some 200), fx 1100 800 (some 250), fx 1400 3200 (some 250), fx 1500 3800 (some 200)]
private def INTERCHANGE : Array CoarseFix := #[fx 1200 2000 (some 20), fx 1250 2010 (some 15)]

private def jview (rs : Array UndergroundRun) : Array (String × String × String) :=
  rs.map fun r => (r.line, r.boardingStation, r.alightingStation)

private def TWO_LEGS : Array (String × String × String) :=
  #[("Victoria Line", "Highbury & Islington", "King's Cross"),
    ("Metropolitan Line", "King's Cross", "Wembley Park")]

-- The single-line arm wins outright and no split is attempted.
#guard jview (reconstructUndergroundJourney COARSE INTERCHANGE BOARD ALIGHT stations oneLine)
  == #[("Victoria Line", "Highbury & Islington", "Wembley Park")]
-- A genuine interchange: two legs meeting at King's Cross.
#guard jview (reconstructUndergroundJourney COARSE INTERCHANGE BOARD ALIGHT stations changeLines) == TWO_LEGS
-- THE PARALLEL-CORRIDOR TRAP, and the pair that makes it a real test: identical
-- geometry to the case above, differing ONLY in the line names. The single arm
-- fails on raw strings, and the canonicalised disjointness test then refuses the
-- split — no phantom interchange on one continuous Metropolitan ride.
#guard reconstructUndergroundJourney COARSE INTERCHANGE BOARD ALIGHT stations sameLineTwoNames == #[]
-- THE DISJOINTNESS TEST, one conjunct at a time. `sameLineTwoNames` above fails
-- SEVERAL at once, so on its own it pins none of them individually — these two
-- pass every other gate and are refused by exactly one.
#guard reconstructUndergroundJourney COARSE INTERCHANGE BOARD ALIGHT stations boardEndCouldRideThrough == #[]
#guard reconstructUndergroundJourney COARSE INTERCHANGE BOARD ALIGHT stations alightEndCouldRideThrough == #[]
-- A cluster deep inside leg2's own zone: refused because no line serves both
-- the board end and that point, so leg1 never resolves. (Named for what it
-- actually tests — an earlier draft called this a station-DISAGREEMENT case,
-- which it is not; see the note on that check below.)
#guard reconstructUndergroundJourney COARSE #[fx 1300 3100 (some 20)] BOARD ALIGHT stations changeLines == #[]
-- Fewer than 2 × MIN_COARSE_FIXES cannot make two real legs.
#guard reconstructUndergroundJourney
  #[fx 1000 200 (some 200), fx 1100 800 (some 250), fx 1400 3200 (some 250)]
  INTERCHANGE BOARD ALIGHT stations changeLines == #[]
-- No mid-run good fixes: nothing pins an interchange.
#guard reconstructUndergroundJourney COARSE #[] BOARD ALIGHT stations changeLines == #[]
-- A cluster OUTSIDE the coarse span, either side, is not a mid-run recovery.
#guard reconstructUndergroundJourney COARSE #[fx 900 2000 (some 20)] BOARD ALIGHT stations changeLines == #[]
#guard reconstructUndergroundJourney COARSE #[fx 1600 2000 (some 20)] BOARD ALIGHT stations changeLines == #[]
-- A cluster so early that one side has too few coarse fixes to reconstruct.
#guard reconstructUndergroundJourney COARSE #[fx 1050 2000 (some 20)] BOARD ALIGHT stations changeLines == #[]
-- Two clusters more than MAX_COARSE_GAP_S apart are distinct candidates; the
-- first that satisfies every gate wins.
#guard jview (reconstructUndergroundJourney COARSE #[fx 1120 2000 (some 20), fx 1450 2000 (some 20)]
  BOARD ALIGHT stations changeLines) == TWO_LEGS
-- CLUSTERING IS LOAD-BEARING. These two fixes are 150 s apart — inside the gap —
-- so they MERGE, and the merged centroid (2000 m) lands at King's Cross. Treated
-- as two clusters they would land at 900 m and 3100 m, each resolving to a leg's
-- OWN endpoint station and being refused.
#guard jview (reconstructUndergroundJourney COARSE #[fx 1150 900 (some 20), fx 1300 3100 (some 20)]
  BOARD ALIGHT stations changeLines) == TWO_LEGS
#guard reconstructUndergroundJourney #[] INTERCHANGE BOARD ALIGHT stations changeLines == #[]

end Verified.Geo.UndergroundJourney
