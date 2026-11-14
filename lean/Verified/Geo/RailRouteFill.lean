import Verified.Fix
/-!
# Which train legs are worth a route fill

A train leg is drawn on rails only when its `<board> → <alight>[ · <line>]`
label has a `rail_route_cache` row, which the nightly job writes, so a label
first ridden today draws raw. `unsnappedTrainRoutes` names the legs a
background worker should fill; the geometry is Rust's.

* `refinedMode ?? mode` decides, in both directions.
* No label, no candidate: the label is the cache key.
* Already snapped, no candidate: the nightly row has better evidence.
* The fix window is inclusive at both ends.
* Legs sharing a key pool their fixes, keeping the first leg's window: a union
  across two rides would name a journey nobody took.
* Order is the day's, and the queue drains in it.
* A leg without fixes is still a candidate: the line fallback may route it.

Pure and total. UNPROVEN; the `#guard`s pin its answers.
-/

namespace Verified.Geo.RailRouteFill

/-- The minimal segment shape the scan reads: the scan does not need a whole
segment, and taking one would tie this to every field that moves. -/
structure FillSegment where
  mode : String
  refinedMode : Option String := none
  startTs : Int
  endTs : Int
  wayName : Option String := none
  /-- Whether the leg already carries a snapped path. The path itself is not
  needed — only whether there is one — so it does not cross the wire. -/
  hasSnappedPath : Bool := false
  deriving Repr, Inhabited

/-- One fix, as the corridor evidence a fill is computed from. -/
abbrev Fix := Verified.GeoFix

/-- A train leg that wanted a snapped route and found no cache row. -/
structure Candidate where
  /-- The leg's `wayName` — the cache key. -/
  key : String
  startTs : Int
  endTs : Int
  /-- The day's own fixes inside the leg's window, pooled across legs sharing
  the key. Carries no `ts`: the snapper reads these as a cloud. -/
  fixes : List (Float × Float)
  deriving Repr, Inhabited

/-- The mode that decides, `refinedMode ?? mode`. -/
def effectiveMode (s : FillSegment) : String :=
  match s.refinedMode with
  | some m => m
  | none => s.mode

/-- Is this leg one the fill should consider at all? -/
def isCandidate (s : FillSegment) : Bool :=
  effectiveMode s == "train" && s.wayName.isSome && !s.hasSnappedPath

/-- The fixes inside `[startTs, endTs]`, inclusive at both ends. -/
def fixesIn (points : List Fix) (startTs endTs : Int) : List (Float × Float) :=
  points.filterMap fun p =>
    if p.ts ≥ startTs && p.ts ≤ endTs then some (p.lat, p.lon) else none

/-- Append `fixes` to the candidate already holding `key`, keeping its window.
`none` when no such candidate exists yet. -/
private def pool (acc : List Candidate) (key : String) (fixes : List (Float × Float))
    : Option (List Candidate) :=
  if acc.any (fun c => c.key == key) then
    some (acc.map fun c => if c.key == key then { c with fixes := c.fixes ++ fixes } else c)
  else none

/-- Scan a computed day for train legs with a route label but no snapped path. -/
def unsnappedTrainRoutes (segments : List FillSegment) (points : List Fix) : List Candidate :=
  segments.foldl (init := []) fun acc s =>
    if !isCandidate s then acc
    else match s.wayName with
      | none => acc          -- unreachable: `isCandidate` required it
      | some key =>
        let fixes := fixesIn points s.startTs s.endTs
        match pool acc key fixes with
        | some merged => merged
        | none => acc ++ [{ key, startTs := s.startTs, endTs := s.endTs, fixes }]

/-! ## Guards

Expectations are recorded `unsnappedTrainRoutes` answers. -/

private def PTS : List Fix :=
  [ { ts := 100, lat := 51.5, lon := -0.1 }
  , { ts := 150, lat := 51.51, lon := -0.11 }
  , { ts := 200, lat := 51.52, lon := -0.12 }
  , { ts := 300, lat := 51.53, lon := -0.13 }
  , { ts := 400, lat := 51.54, lon := -0.14 } ]

private def seg (wayName : Option String) (startTs endTs : Int)
    (mode : String := "train") (refinedMode : Option String := none)
    (hasSnappedPath : Bool := false) : FillSegment :=
  { mode, refinedMode, startTs, endTs, wayName, hasSnappedPath }

/-- `(key, startTs, endTs, #fixes)` — what the refs script printed. -/
private def shape (cs : List Candidate) : List (String × Int × Int × Nat) :=
  cs.map fun c => (c.key, c.startTs, c.endTs, c.fixes.length)

#guard shape (unsnappedTrainRoutes [seg (some "A → B · L") 100 200] PTS)
  == [("A → B · L", 100, 200, 3)]
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 100 200 "walk"] PTS) == []
-- The refined mode decides, in both directions.
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 100 200 "train" (some "car")] PTS) == []
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 100 200 "car" (some "train")] PTS)
  == [("A → B", 100, 200, 3)]
-- No label: nothing to key a cache row on.
#guard shape (unsnappedTrainRoutes [seg none 100 200] PTS) == []
-- Already drawn on rails.
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 100 200 "train" none true] PTS) == []
-- Inclusive at both ends: ts 100 and ts 200 are both inside [100, 200].
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 100 200] PTS)
  == [("A → B", 100, 200, 3)]
-- Two legs, one key: fixes pool (3 + 2 = 5) and the first window is kept.
#guard shape (unsnappedTrainRoutes
  [seg (some "A → B") 100 200, seg (some "A → B") 300 400] PTS)
  == [("A → B", 100, 200, 5)]
-- Two keys stay two candidates, in the order the day was walked.
#guard shape (unsnappedTrainRoutes
  [seg (some "B → C") 300 400, seg (some "A → B") 100 200] PTS)
  == [("B → C", 300, 400, 2), ("A → B", 100, 200, 3)]
-- A window with no fixes is still a candidate — the line fallback may route it.
#guard shape (unsnappedTrainRoutes [seg (some "A → B") 900 950] PTS)
  == [("A → B", 900, 950, 0)]
#guard shape (unsnappedTrainRoutes [] PTS) == []

end Verified.Geo.RailRouteFill
