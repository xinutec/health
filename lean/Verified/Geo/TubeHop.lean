import Verified.Geo.RailRuns
/-!
# Tube-hop upgrade (port of `src/geo/passes/tube-hop.ts` + `pickBestStation`)

Upgrade a fast station-to-station `driving` leg to `train`. `driving` is the
placeholder every pass uses for an unidentified vehicle-speed run, and a short
Underground hop between two stations looks exactly like one until somebody
checks the endpoints.

The TS `upgradeTubeHops` is `async`, but only because the two OSM lookups are
injected as promises — its docstring says so, and it is otherwise pure. Modelled
here with the lookups as ordinary functions of a coordinate, which is what let
the private `findBlackoutHop` be reference-tested through the public pass rather
than by adding a test-only export.

## Two sufficient signatures, both checked before any lookup

* **Speed** — an average no bus explains (≥ 28 km/h).
* **Blackout** — the tunnel shape: the leg's displacement concentrated in ONE
  motorised inter-fix hop, with everything observed around it at walking pace.
  Robust to a surviving poor-accuracy fix mid-blackout, which splits the gap in
  two while the reacquire hop still carries the displacement.

Both are pure and are tested first, so a leg with neither makes no OSM query at
all and an adjacent-train day stays fixture-stable.

## The gates that a taxi fails

Both endpoints must resolve to real, DISTINCT stations, and at least one
canonicalised line must serve both. A taxi between two addresses fails the
first; two stations on unrelated lines fail the second. The line is only NAMED
when exactly one is shared — the sub-surface stations share three, and picking
one of those would be a guess, so the label stays a bare station pair.

Exactness: every gate is exact; `haversineMeters` (atan2) puts the hop
distances at ≤ 1 ULP. UNPROVEN; pinned against Node/V8
(`lean/experiments/tube-hop-refs.mts`).
-/

namespace Verified.Geo.TubeHop

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Geo.RailRuns (expandTubeLineNames)

abbrev Mode := String

structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- A rail station near a coordinate, as the OSM adapter reports it. -/
structure NearbyStation where
  name : String
  subtype : String := "station"
  distanceM : Float
  deriving Inhabited, BEq, Repr

/-- The `EnrichedSegment` fields this pass reads and rewrites. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  refinedReason : Option String := none
  wayName : Option String := none
  avgSpeed : Float
  deriving Inhabited, BEq, Repr

def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `pickBestStation` -/

/-- Whether a name is an entrance CODE — a bare capital optionally followed by
ONE digit (`"A"`, `"B2"`). The TS regex is `^[A-Z]\d?$`, so `"B22"` and `"a"`
are real names. -/
def isEntranceCode (name : String) : Bool :=
  match name.toList with
  | [c] => c.isUpper
  | [c, d] => c.isUpper && d.isDigit
  | _ => false

def isEntranceLike (s : NearbyStation) : Bool :=
  s.subtype == "subway_entrance" || isEntranceCode s.name

/-- The nearest REAL station, falling back to the nearest entrance when every
candidate is entrance-like — an entrance still locates the station, so returning
nothing there would lose the evidence.

Ties keep input order: the TS sorts stably and takes the head, and a fold that
improves only on STRICT `<` is the same function. -/
def pickBestStation (stations : Array NearbyStation) : Option NearbyStation :=
  let nearest (xs : Array NearbyStation) : Option NearbyStation :=
    xs.foldl (init := none) fun best s =>
      match best with
      | some b => if s.distanceM < b.distanceM then some s else best
      | none => some s
  let real := stations.filter (!isEntranceLike ·)
  if real.isEmpty then nearest stations else nearest real

/-! ## `findBlackoutHop` -/

/-- Average below which no bus explains the leg, so the speed alone identifies
a rail hop. -/
def TUBE_HOP_MIN_AVG_KMH : Float := 28
/-- Share of the leg's NET displacement one inter-fix hop must carry for the
blackout shape to hold. -/
def TUBE_HOP_BLACKOUT_MIN_SHARE : Float := 0.6
/-- …and the speed that hop implies must be motorised. -/
def TUBE_HOP_BLACKOUT_MIN_KMH : Float := 25
/-- Everything observed AROUND the hop must be at walking pace — that is what
separates a tunnel from a drive with one sparse stretch. -/
def TUBE_HOP_SURFACE_MAX_KMH : Float := 8

/-- Fixes inside a segment's window, INCLUSIVE both ends. -/
def samplesInWindow (points : Array Fix) (startTs endTs : Int) : Array Fix :=
  points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/-- The bounding fix indices of the tunnel-blackout hop, or `none`.

Last-seen-before-the-tunnel and first-seen-after are the board / alight
evidence: the leg's OWN first fix trails the preceding walk through Kalman lag
and can resolve to the wrong station.

A zero-duration hop (duplicate timestamps) is still a teleport, so its implied
speed is `+∞` rather than a division by zero. -/
def findBlackoutHop (fixes : Array Fix) : Option (Nat × Nat) := Id.run do
  if fixes.isEmpty then return none
  let first := fixes[0]!
  let last := fixes[fixes.size - 1]!
  let netM := haversineMeters first.lat first.lon last.lat last.lon
  if netM ≤ 0 then return none
  let mut bestM : Float := 0
  let mut bestS : Int := 0
  let mut bestEnd : Nat := 0
  let mut totalM : Float := 0
  for i in [1:fixes.size] do
    let d := haversineMeters fixes[i - 1]!.lat fixes[i - 1]!.lon fixes[i]!.lat fixes[i]!.lon
    totalM := totalM + d
    if d > bestM then
      bestM := d
      bestS := fixes[i]!.ts - fixes[i - 1]!.ts
      bestEnd := i
  if bestM / netM < TUBE_HOP_BLACKOUT_MIN_SHARE then return none
  let impliedKmh := if bestS > 0 then bestM / Float.ofInt bestS * 3.6 else (1.0 / 0.0)
  if impliedKmh < TUBE_HOP_BLACKOUT_MIN_KMH then return none
  let surfaceS := last.ts - first.ts - bestS
  let surfaceKmh := if surfaceS > 0 then (totalM - bestM) / Float.ofInt surfaceS * 3.6 else 0
  return if surfaceKmh ≤ TUBE_HOP_SURFACE_MAX_KMH then some (bestEnd - 1, bestEnd) else none

/-! ## `upgradeTubeHops` -/

/-- Upgrade fast station-to-station `driving` legs to `train`. Segments that do
not qualify pass through untouched.

`stationsLookup` and `linesLookup` stand for the injected OSM calls; in the TS
they are promises, here plain functions of a coordinate. -/
def upgradeTubeHops (segments : Array Seg) (points : Array Fix)
    (stationsLookup : Float → Float → Array NearbyStation)
    (linesLookup : Float → Float → Array String) : Array Seg :=
  segments.mapIdx fun i seg =>
    if effectiveMode seg != "driving" then seg
    else
      -- A genuine isolated hop is bracketed by walks. A fast driving leg beside
      -- a `train` is a fragment of THAT ride — surfaced GPS at its head or tail,
      -- or an interchange sliver — and upgrading it splits one ride in pieces.
      -- Checked before any lookup so an adjacent-train day makes no new query.
      let prevIsTrain := i != 0 && (segments[i - 1]?).any (effectiveMode · == "train")
      let nextIsTrain := (segments[i + 1]?).any (effectiveMode · == "train")
      if prevIsTrain || nextIsTrain then seg
      else
        let fixes := samplesInWindow points seg.startTs seg.endTs
        if fixes.size < 2 then seg
        else
          let slow := seg.avgSpeed < TUBE_HOP_MIN_AVG_KMH
          let blackout := if slow then findBlackoutHop fixes else none
          if slow && blackout.isNone then seg
          else
            let board := match blackout with
              | some (s, _) => fixes[s]!
              | none => fixes[0]!
            let alight := match blackout with
              | some (_, e) => fixes[e]!
              | none => fixes[fixes.size - 1]!
            match pickBestStation (stationsLookup board.lat board.lon),
                  pickBestStation (stationsLookup alight.lat alight.lon) with
            | some boardStation, some alightStation =>
              if boardStation.name == alightStation.name then seg
              else
                -- OSM names each travel direction as its own line; canonicalise
                -- before intersecting. One shared line ⇒ a single Underground
                -- line serves both ends ⇒ a rail corridor.
                let canon (ls : Array String) : Array String :=
                  ls.foldl (init := #[]) fun acc l =>
                    (expandTubeLineNames l).foldl (fun a x => if a.contains x then a else a.push x) acc
                let boardCanon := canon (linesLookup board.lat board.lon)
                let alightCanon := canon (linesLookup alight.lat alight.lon)
                let shared := boardCanon.filter (alightCanon.contains ·)
                if shared.isEmpty then seg
                else
                  let base := s!"{boardStation.name} → {alightStation.name}"
                  { seg with
                    mode := "train"
                    refinedMode := some "train"
                    wayName := some (if shared.size == 1 then s!"{base} · {shared[0]!}" else base)
                    refinedReason := some
                      (s!"tube hop {if blackout.isSome then "blackout" else "station-pair"}"
                        ++ (match seg.refinedReason with
                            | some r => if r == "" then "" else s!" (was: {r})"
                            | none => "")) }
            | _, _ => seg

/-! ## Guards (V8 reference values) -/

private def st (name : String) (distanceM : Float) (subtype : String := "station") : NearbyStation :=
  { name, subtype, distanceM }

#guard (pickBestStation #[st "Far" 300, st "Near" 50]).map (·.name) == some "Near"
-- An entrance is skipped for a real station however much further away…
#guard (pickBestStation #[st "Entrance" 5 "subway_entrance", st "Real" 400]).map (·.name) == some "Real"
-- …and so is an entrance CODE name: a bare capital, optionally one digit.
#guard (pickBestStation #[st "A" 5, st "Real" 400]).map (·.name) == some "Real"
#guard (pickBestStation #[st "B2" 5, st "Real" 400]).map (·.name) == some "Real"
-- Two digits, or lowercase, is a real name.
#guard (pickBestStation #[st "B22" 5, st "Real" 400]).map (·.name) == some "B22"
#guard (pickBestStation #[st "a" 5, st "Real" 400]).map (·.name) == some "a"
-- With ONLY entrances the nearest entrance comes back — it still locates the
-- station, so returning nothing would lose the evidence.
#guard (pickBestStation #[st "Entrance" 400 "subway_entrance", st "A" 50]).map (·.name) == some "A"
-- Equal distances keep input order.
#guard (pickBestStation #[st "First" 100, st "Second" 100]).map (·.name) == some "First"
#guard pickBestStation #[] == none

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def north (n : Float) : Float × Float := (lat0 + n * mlat, lon0)
#guard (north 3000).1 == 51.546949335249735

private def fx (ts : Int) (metresNorth : Float) : Fix :=
  { ts, lat := (north metresNorth).1, lon := (north metresNorth).2 }

/-- Stations resolve by which end of the frame the query lands nearest. -/
private def stationsAt (lat : Float) (_lon : Float) : Array NearbyStation :=
  if lat < lat0 + 1500 * mlat then #[st "Euston Square" 40] else #[st "Wembley Park" 60]
private def oneLine (_lat _lon : Float) : Array String := #["Metropolitan Line"]
private def threeLines (_lat _lon : Float) : Array String :=
  #["Circle, Hammersmith & City and Metropolitan Lines"]
private def directional (lat _lon : Float) : Array String :=
  #[if lat < lat0 + 1500 * mlat then "Metropolitan Line Northbound" else "Metropolitan Line Southbound"]
private def disjointLines (lat _lon : Float) : Array String :=
  #[if lat < lat0 + 1500 * mlat then "Metropolitan Line" else "Jubilee Line"]
private def noStations (_lat _lon : Float) : Array NearbyStation := #[]
private def sameStation (_lat _lon : Float) : Array NearbyStation := #[st "Euston Square" 40]

private def FAST : Array Fix := #[fx 1000 0, fx 1300 3000]
private def BLACKOUT : Array Fix := #[fx 1000 0, fx 1100 50, fx 1220 3050, fx 1320 3100]
private def DIFFUSE : Array Fix := #[fx 1000 0, fx 1200 1000, fx 1400 2000, fx 1600 3000]

private def dr (a b : Int) (avgSpeed : Float) (mode : Mode := "driving")
    (refinedReason : Option String := none) : Seg :=
  { startTs := a, endTs := b, mode, avgSpeed, refinedReason }

private def hview (out : Array Seg) : Array (Int × Mode × Option String × Option String) :=
  out.map fun s => (s.startTs, s.mode, s.wayName, s.refinedReason)

private def LABEL : String := "Euston Square → Wembley Park · Metropolitan Line"

-- The SPEED signature: 40 km/h between two stations on one line.
#guard hview (upgradeTubeHops #[dr 1000 1300 40] FAST stationsAt oneLine)
  == #[(1000, "train", some LABEL, some "tube hop station-pair")]
-- The BLACKOUT signature: a slow average, but one motorised hop carries the
-- displacement and the surface fixes are at walking pace.
#guard hview (upgradeTubeHops #[dr 1000 1320 10] BLACKOUT stationsAt oneLine)
  == #[(1000, "train", some LABEL, some "tube hop blackout")]
-- THE SPEED BAR, isolated — same geometry, only the average differs. 28 exactly
-- clears it (`<`), so the leg upgrades on the station pair without the blackout
-- shape being consulted; a hair under, and it upgrades via the BLACKOUT arm.
-- The reason string is the discriminator.
#guard (upgradeTubeHops #[dr 1000 1300 28] FAST stationsAt oneLine)[0]!.refinedReason
  == some "tube hop station-pair"
#guard (upgradeTubeHops #[dr 1000 1300 27.9] FAST stationsAt oneLine)[0]!.refinedReason
  == some "tube hop blackout"
-- Slow AND diffuse: no single hop carries the displacement, so neither
-- signature holds and no lookup is made.
#guard (upgradeTubeHops #[dr 1000 1600 10] DIFFUSE stationsAt oneLine)[0]!.mode == "driving"
-- The blackout gate's THREE refusals, each isolated. An earlier draft exercised
-- only the SHARE gate — `DIFFUSE` refuses there first, so the other two were
-- never reached and their probes came back empty.
--   Implied speed: one hop carries everything, but over 50 minutes. A crawl,
--   not a tunnel transit.
#guard (upgradeTubeHops #[dr 1000 4000 10] #[fx 1000 0, fx 4000 3000] stationsAt oneLine)[0]!.mode == "driving"
--   Surface pace: the hop is genuinely motorised, but what is observed around it
--   moves at 18 km/h — a drive with one sparse stretch.
#guard (upgradeTubeHops #[dr 1000 1200 10] #[fx 1000 0, fx 1100 500, fx 1200 3500]
    stationsAt oneLine)[0]!.mode == "driving"
--   Share: 0.633 of the net displacement in one hop clears the 0.6 bar, with the
--   remainder at walking pace. This pins the CONSTANT — a 0.65 bar refuses it —
--   not the strictness, which needs an input exactly ON the bar and so stays
--   unpinnable here.
#guard (upgradeTubeHops #[dr 1000 1700 10] #[fx 1000 0, fx 1600 1100, fx 1700 3000]
    stationsAt oneLine)[0]!.refinedReason == some "tube hop blackout"
-- A ZERO-DURATION hop (duplicate timestamps) is still a teleport: infinite
-- implied speed rather than a division by zero.
#guard (upgradeTubeHops #[dr 1000 1000 10] #[fx 1000 0, fx 1000 3000]
    stationsAt oneLine)[0]!.refinedReason == some "tube hop blackout"
-- The board fix is the hop's START, not the leg's first fix — the first fix
-- trails the preceding walk through Kalman lag and can resolve to the wrong
-- station. Here the two sit on opposite sides of the station boundary, so using
-- the leg's first fix would resolve BOTH ends to Wembley Park and refuse.
#guard (upgradeTubeHops #[dr 1000 1220 10] #[fx 1000 1600, fx 1100 1400, fx 1220 4400]
    stationsAt oneLine)[0]!.wayName == some LABEL
-- Adjacent to a train on EITHER side: a fragment of that ride, not a hop.
#guard (upgradeTubeHops #[dr 0 1000 40 "train", dr 1000 1300 40] FAST stationsAt oneLine)[1]!.mode == "driving"
#guard (upgradeTubeHops #[dr 1000 1300 40, dr 1300 2000 40 "train"] FAST stationsAt oneLine)[0]!.mode == "driving"
-- Not driving; too few fixes in the window. (`< 2` versus `< 1` is provably
-- unobservable: with ONE fix the board and alight fixes are the same fix, so
-- the same-station gate refuses anyway. Kept as the TS has it.)
#guard (upgradeTubeHops #[dr 1000 1300 40 "walking"] FAST stationsAt oneLine)[0]!.mode == "walking"
#guard (upgradeTubeHops #[dr 1000 1050 40] FAST stationsAt oneLine)[0]!.mode == "driving"
-- The station gates a taxi between two addresses fails: no station at all, or
-- both endpoints resolving to the SAME one.
#guard (upgradeTubeHops #[dr 1000 1300 40] FAST noStations oneLine)[0]!.mode == "driving"
#guard (upgradeTubeHops #[dr 1000 1300 40] FAST sameStation oneLine)[0]!.mode == "driving"
-- No shared line: two stations, but not one corridor.
#guard (upgradeTubeHops #[dr 1000 1300 40] FAST stationsAt disjointLines)[0]!.mode == "driving"
-- Directional variants canonicalise to the same line and still intersect.
#guard (upgradeTubeHops #[dr 1000 1300 40] FAST stationsAt directional)[0]!.wayName == some LABEL
-- THREE shared lines (the sub-surface stations): naming one of three would be a
-- guess, so the label stays a bare station pair.
#guard (upgradeTubeHops #[dr 1000 1300 40] FAST stationsAt threeLines)[0]!.wayName
  == some "Euston Square → Wembley Park"
-- An existing reason is quoted in the new one.
#guard (upgradeTubeHops #[dr 1000 1300 40 (refinedReason := some "earlier note")] FAST stationsAt oneLine)[0]!.refinedReason
  == some "tube hop station-pair (was: earlier note)"
#guard upgradeTubeHops #[] FAST stationsAt oneLine == #[]

end Verified.Geo.TubeHop
