/-!
# Which stations does a line serve? (port of `src/geo/line-stations.ts`)

`stationsOnLine` is the PRODUCER for `Verified.Geo.LineMembership`, which until
now took its answer as an injected `String → Array ServedStation`. That injection
was honest while the answer came out of MariaDB; it is a hole once the row-set
pushes the raw rows (#414), because the decision it stands for — "this station is
within 300 m of some way of this line" — is exactly the kind of spatial judgement
the OSM port exists to move out of the database.

## The mirror does not record membership, so this INFERS it

OSM route relations name their member stops, but the local mirror ingests way
geometry only. So membership is proximity-inferred: a station point within
`MAX_DIST_M` of any way of the line counts as served. The error direction is
OVER-inclusion — a station beside a passing-but-not-stopping line counts — which
is what makes the result safe as a veto and useless as an assertion. See
`LineMembership`, which consumes it and says the same thing from the other side.

300 m is not a tolerance, it is a physical offset: a surface station's named node
sits 20-80 m from the track, while a tube station's named node is at the STREET
entrance and the tunnel runs 150-300 m horizontally beneath it. One bar covers
both regimes.

## The line's own metric — a FIFTH distance function in this repo

`pointToSegmentM` projects with an equirectangular approximation at the
SEGMENT MIDPOINT and `111_320` m/deg, then `Math.hypot`. That is:

* not `Verified.Geo.EpisodeGeometry.equirectMeters`, which uses the FIRST point's
  cosine and `sqrt`;
* not `WalkableRoute.metersBetween`;
* not `OsmSpatial`'s `lineDistDeg`, which works in degrees against MariaDB's
  own metric and is the one the five bbox lookups use;
* not the sphere `haversineMeters` uses.

They disagree, and each is load-bearing where it sits — the corpus was blessed
under this one for this predicate. Do not unify them. (The mirror image of the
`Board → Alight · Line` parser landmine: same-shaped functions, deliberately
different, and the guards are what stop a well-meaning merge.)

## `lineBaseToken` strips a qualifier, and the regex has teeth

`/\s+lines?\b.*$/i` on `String.replace` (non-global — FIRST match only), then
`trim`. "Victoria Line" → "Victoria"; "Circle and District Lines" → "Circle and
District"; "Northern Line (Bank Branch)" → "Northern", because `.*$` eats the
parenthetical too. A name with no whitespace-preceded "line" is returned whole,
so "514a" and "Belsize Fast Tunnel" survive intact — and "Line 1" survives as
well, since `\s+` cannot match before position 0.

`\b` after `lines?` is what stops "Lineside" matching: JS tries "line" first,
finds no boundary between 'e' and 's' in "lines", backtracks to "lines", and
then needs a boundary after the final 's'.

## Deviations from the TS, both deliberate

* The DB reads (`loadRailwayLineNames`, `loadAllRailwayStations`) and the
  in-process cache are shell. What arrives here is the pushed data.
* `String.prototype.trim` covers Unicode `Zs`; `trimAscii` does not. Line names
  in the mirror are ASCII apart from an en dash inside `London–Aylesbury Line`,
  which neither trims nor folds.

Exactness: `cos` and `hypot` enter, so distances are `approx` (≤1 ULP). The
name functions and the kept-set are EXACT. UNPROVEN; pinned against Node/V8
(`lean/experiments/line-stations-refs.mts`).
-/

namespace Verified.Geo.LineStations

/-- Max metres from a station point to any way of the line for the station to
count as served. See the header on why one bar covers surface and tube. -/
def MAX_DIST_M : Float := 300.0

/-- The module's own metres-per-degree of latitude. NOT `OsmSpatial`'s 111_000
nor the sphere's 111_194.68 — see the header's list of five. -/
def M_PER_DEG_LAT : Float := 111_320.0

def metersPerDegLon (lat : Float) : Float :=
  M_PER_DEG_LAT * Float.cos (lat * 3.141592653589793 / 180.0)

/-- A station candidate: a name and a position. -/
structure StationCandidate where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- A way of a line, already parsed to `(lat, lon)` pairs. -/
structure WayGeometry where
  coords : Array (Float × Float)
  deriving Inhabited, Repr

/-! ## Name resolution -/

private def isAsciiWordChar (c : Char) : Bool :=
  c.isAlphanum || c == '_'

private def isSpace (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '' || c == ''

/-- Does `s` read `line` or `lines` at `i`, case-insensitively and followed by a
word boundary? Returns the index just past the match, or `none`. -/
private def matchLineWord (cs : Array Char) (i : Nat) : Option Nat :=
  let at? (k : Nat) : Option Char := cs[k]?
  let lower (c : Char) := c.toLower
  let spells (k : Nat) (word : List Char) : Bool :=
    word.zipIdx.all (fun (c, off) => match at? (k + off) with
      | some d => lower d == c
      | none => false)
  -- Greedy in the same order JS backtracks: try "lines" first so the boundary
  -- test lands after the 's' rather than inside the word.
  if spells i ['l', 'i', 'n', 'e', 's'] then
    match at? (i + 5) with
    | some d => if isAsciiWordChar d then none else some (i + 5)
    | none => some (i + 5)
  else if spells i ['l', 'i', 'n', 'e'] then
    match at? (i + 4) with
    | some d => if isAsciiWordChar d then none else some (i + 4)
    | none => some (i + 4)
  else none

/-- The first index at which `\s+lines?\b` matches, i.e. where the qualifier
starts. Scans left to right, as the regex engine does. -/
private def qualifierStart (cs : Array Char) : Option Nat :=
  let rec go (i : Nat) (fuel : Nat) : Option Nat :=
    match fuel with
    | 0 => none
    | fuel + 1 =>
      if h : i < cs.size then
        if isSpace cs[i] then
          -- `\s+` is greedy and whitespace is never 'l', so the run must be
          -- consumed whole before the word can match; no backtracking to model.
          let rec skip (j : Nat) (f : Nat) : Nat :=
            match f with
            | 0 => j
            | f + 1 => if h : j < cs.size then (if isSpace cs[j] then skip (j + 1) f else j) else j
          let j := skip i cs.size
          match matchLineWord cs j with
          | some _ => some i
          | none => go j fuel
        else go (i + 1) fuel
      else none
  go 0 (cs.size + 1)

/--
A line's name with any trailing " line"/" lines …" qualifier stripped, trimmed.

Exported because `rail-stops-cache.ts` matches relations with the same
normalisation, and the two must not drift.
-/
def lineBaseToken (lineName : String) : String :=
  let cs := lineName.toList.toArray
  match qualifierStart cs with
  | none => lineName.trimAscii.toString
  | some i => (String.ofList (cs.toList.take i)).trimAscii.toString

/--
The distinct mirror names containing `lineName`'s base token, case-insensitively
— exactly the set a `name LIKE '%base%'` would have matched.

A name stripping to the empty base matches NOTHING. That is deliberate and not a
degenerate case: `'%%'` would have matched every line in the mirror, so the
indexed path stays conservative where the LIKE was permissive.
-/
def lineNamesMatching (lineName : String) (allNames : Array String) : Array String :=
  let base := lineBaseToken lineName
  if base.isEmpty then #[]
  else
    let needle := base.toLower
    -- `String.contains` takes a Char, and this core has no `containsSubstr`;
    -- `splitOn` yielding more than one piece is the substring test.
    allNames.filter (fun (n : String) => (String.splitOn n.toLower needle).length > 1)

/-! ## Geometry -/

/-- Distance in metres from a point to a segment, projected equirectangularly at
the SEGMENT MIDPOINT. See the header: this metric is this module's own. -/
def pointToSegmentM (pLat pLon : Float) (a b : Float × Float) : Float :=
  let refLat := (a.1 + b.1) / 2.0
  let mPerLon := metersPerDegLon refLat
  let ax := a.2 * mPerLon
  let ay := a.1 * M_PER_DEG_LAT
  let bx := b.2 * mPerLon
  let by' := b.1 * M_PER_DEG_LAT
  let px := pLon * mPerLon
  let py := pLat * M_PER_DEG_LAT
  let dx := bx - ax
  let dy := by' - ay
  let len2 := dx * dx + dy * dy
  let t0 := if len2 == 0.0 then 0.0 else ((px - ax) * dx + (py - ay) * dy) / len2
  let t := if t0 < 0.0 then 0.0 else if t0 > 1.0 then 1.0 else t0
  let distX := px - (ax + t * dx)
  let distY := py - (ay + t * dy)
  Float.sqrt (distX * distX + distY * distY)

/-- Minimum distance from a point to a polyline. A polyline of fewer than two
vertices is INFINITELY far — it has no segment to be near, and returning 0 would
make every degenerate way match every station. -/
def pointToLineDistanceM (pLat pLon : Float) (coords : Array (Float × Float)) : Float :=
  if coords.size < 2 then (1.0 / 0.0)
  else
    (List.range (coords.size - 1)).foldl
      (fun acc i =>
        let d := pointToSegmentM pLat pLon coords[i]! coords[i + 1]!
        if d < acc then d else acc)
      (1.0 / 0.0)

/-- A way with its bounding box, precomputed once. -/
private structure ParsedWay where
  coords : Array (Float × Float)
  minLat : Float
  maxLat : Float
  minLon : Float
  maxLon : Float

private def parseWay (w : WayGeometry) : Option ParsedWay :=
  if w.coords.size < 2 then none
  else
    let f := w.coords[0]!
    some (w.coords.foldl
      (fun acc c =>
        { acc with
          minLat := min acc.minLat c.1, maxLat := max acc.maxLat c.1,
          minLon := min acc.minLon c.2, maxLon := max acc.maxLon c.2 })
      { coords := w.coords, minLat := f.1, maxLat := f.1, minLon := f.2, maxLon := f.2 })

/--
Keep the station candidates within `MAX_DIST_M` of any of the ways. Dedupes by
NAME and preserves input order.

Ports the TS `filterStationsByLineProximityParsed` — the geometry decision alone.
Its sibling `filterStationsByLineProximity` is the WKT wrapper, which parses and
then calls this; parsing is boundary work, not part of the rule.

Order is part of the answer, not incidental: downstream journey resolution reads
positional relationships out of this list, so a set-equal-but-reordered result is
a different result.

The bbox pre-filter is a cheap reject before the per-segment math, and it is
output-identical rather than approximate — the box is padded by `MAX_DIST_M`, so
it is a conservative superset of the neighbourhood and the exact test behind it
is unchanged. The longitude pad uses the SMALLEST cosine over all the data (the
most poleward latitude), which can only widen the box: a wider box costs extra
exact tests, never a wrong reject.
-/
def filterStationsByLineProximity
    (stations : Array StationCandidate) (ways : Array WayGeometry) : Array StationCandidate :=
  if stations.isEmpty || ways.isEmpty then #[]
  else
    let padLat := MAX_DIST_M / M_PER_DEG_LAT
    let parsed := ways.filterMap parseWay
    if parsed.isEmpty then #[]
    else
      let maxAbsLat := ways.foldl
        (fun acc w => w.coords.foldl (fun a c => max a (Float.abs c.1)) acc) 0.0
      let padLon := MAX_DIST_M / metersPerDegLon maxAbsLat
      let near (s : StationCandidate) : Bool :=
        parsed.any (fun w =>
          if s.lat < w.minLat - padLat || s.lat > w.maxLat + padLat
              || s.lon < w.minLon - padLon || s.lon > w.maxLon + padLon then false
          else pointToLineDistanceM s.lat s.lon w.coords <= MAX_DIST_M)
      (stations.foldl
        (fun (acc : Array String × Array StationCandidate) s =>
          if acc.1.contains s.name then acc
          else if near s then (acc.1.push s.name, acc.2.push s)
          else acc)
        (#[], #[])).2

/-! ## Guards

`maxAbsLat` is computed over ALL ways including the sub-two-vertex ones that
`parseWay` drops — a quirk of the TS's two loops, reproduced here rather than
tidied, since a dropped way can still widen the longitude pad.
-/

-- lineBaseToken: the qualifier strip.
#guard lineBaseToken "Victoria Line" == "Victoria"
#guard lineBaseToken "Circle and District Lines" == "Circle and District"
#guard lineBaseToken "North London line" == "North London"
-- `.*$` eats the parenthetical, so a branch name collapses to the bare line.
#guard lineBaseToken "Northern Line (Bank Branch)" == "Northern"
#guard lineBaseToken "Northern Line (Charing Cross Branch) Southbound" == "Northern"
#guard lineBaseToken "Victoria Line Northbound" == "Victoria"
-- No whitespace-preceded "line" at all: returned whole.
#guard lineBaseToken "514a" == "514a"
#guard lineBaseToken "Belsize Fast Tunnel" == "Belsize Fast Tunnel"
#guard lineBaseToken "SPC1" == "SPC1"
-- `\s+` cannot match before position 0, so a leading "Line" is not a qualifier.
#guard lineBaseToken "Line 1" == "Line 1"
-- The word boundary: "Lineside" is not "line".
#guard lineBaseToken "Wembley Lineside Path" == "Wembley Lineside Path"
-- FIRST match wins, and it takes everything after it.
#guard lineBaseToken "A Line and B Line" == "A"
-- An en dash is neither whitespace nor a word char here.
#guard lineBaseToken "London–Aylesbury Line" == "London–Aylesbury"
-- Strips to empty: matches nothing rather than everything.
#guard lineBaseToken " Line" == ""

private def mirrorNames : Array String :=
  #["Victoria Line", "Victoria Line Northbound", "Bakerloo Line", "North London line",
    "North London Line Connection", "Circle and District Lines", "Metropolitan Line"]

#guard lineNamesMatching "Victoria Line" mirrorNames == #["Victoria Line", "Victoria Line Northbound"]
-- The directional variant expands to the SAME set — which is why candidates
-- derived from a day's own way names cover the labels the pipeline asks about.
#guard lineNamesMatching "Victoria Line Northbound" mirrorNames == lineNamesMatching "Victoria Line" mirrorNames
#guard lineNamesMatching "North London line" mirrorNames == #["North London line", "North London Line Connection"]
-- Matching is case-insensitive on BOTH sides.
#guard lineNamesMatching "VICTORIA LINE" mirrorNames == #["Victoria Line", "Victoria Line Northbound"]
#guard lineNamesMatching "Jubilee Line" mirrorNames == #[]
#guard lineNamesMatching " Line" mirrorNames == #[]

/-! A north-south line at longitude 0, from which metric distances are easy to
read: at latitude 0 a degree of longitude is `M_PER_DEG_LAT` metres. -/

private def nsWay : WayGeometry := ⟨#[(-0.01, 0.0), (0.01, 0.0)]⟩

-- On the line.
#guard pointToLineDistanceM 0.0 0.0 nsWay.coords == 0.0
-- 200 m east: within the bar.
#guard (pointToLineDistanceM 0.0 (200.0 / 111_320.0) nsWay.coords - 200.0).abs < 1e-6
-- 400 m east: outside it.
#guard (pointToLineDistanceM 0.0 (400.0 / 111_320.0) nsWay.coords - 400.0).abs < 1e-6
-- Past the end, so the projection clamps to the endpoint rather than the line.
#guard pointToLineDistanceM 0.02 0.0 nsWay.coords > 1000.0
-- A one-vertex way is infinitely far, not zero.
#guard pointToLineDistanceM 0.0 0.0 #[(0.0, 0.0)] == (1.0 / 0.0)
#guard pointToLineDistanceM 0.0 0.0 #[] == (1.0 / 0.0)
-- A degenerate two-vertex way (len2 == 0) takes the `t = 0` branch.
#guard pointToLineDistanceM 0.0 0.0 #[(0.0, 0.0), (0.0, 0.0)] == 0.0

private def stations : Array StationCandidate :=
  #[⟨"On It", 0.0, 0.0⟩,
    ⟨"Just Inside", 0.005, 250.0 / 111_320.0⟩,
    ⟨"Just Outside", 0.005, 350.0 / 111_320.0⟩,
    ⟨"Far Away", 0.0, 5000.0 / 111_320.0⟩]

#guard (filterStationsByLineProximity stations #[nsWay]).map (·.name) == #["On It", "Just Inside"]
-- Input order is preserved, not distance order: "On It" is nearer but the
-- answer would read the same either way, so the case that pins it is a REVERSED
-- input, where a distance sort would flip the pair.
#guard (filterStationsByLineProximity stations.reverse #[nsWay]).map (·.name) == #["Just Inside", "On It"]
-- Dedupe is by NAME and keeps the FIRST occurrence, so a second node of the
-- same station — the shape `dedupeStationsByName` exists for — cannot double up.
#guard (filterStationsByLineProximity
    (#[⟨"On It", 0.0, 0.0⟩, ⟨"On It", 0.002, 0.0⟩] : Array StationCandidate) #[nsWay]).size == 1
-- No ways, or no stations: empty, and never a throw.
#guard filterStationsByLineProximity stations #[] == #[]
#guard filterStationsByLineProximity #[] #[nsWay] == #[]
-- Every way sub-two-vertex: the parsed set is empty and the answer is too.
#guard filterStationsByLineProximity stations #[⟨#[(0.0, 0.0)]⟩] == #[]

end Verified.Geo.LineStations
