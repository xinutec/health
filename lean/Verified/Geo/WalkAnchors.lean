import Verified.Geo.SegmentMerge
import Verified.Geo.PathPoint
/-!
# Walk endpoint anchors (port of `walkEndpointAnchors`, `pedestrian-match-annotate.ts`)

A walking leg's endpoints are often confidently known from its NEIGHBOURS: the
stay it left or arrived at contributes its centroid, and the train it alighted
from or boarded contributes the snapped track's terminal vertex — which sits at
the station to about platform precision. A post-tunnel reacquire smear
contradicts both, so these anchors pin the reconstruction between the known
truths (#319).

Only a TEMPORALLY ADJACENT neighbour testifies. Across a long unknown gap the
endpoint is genuinely unknown, so a neighbour more than three minutes away says
nothing at all. Note the gap test is ONE-SIDED (`> 180`), so a neighbour that
OVERLAPS the walk — a negative gap — still testifies.

This is the last exported pure leaf in `computeVelocity`'s dependency set.
Everything else `pedestrian-match-annotate.ts` exports is a mutable diagnostic
sink or the async `annotateWalkMatches`, both shell.

Wholly EXACT — the only arithmetic is a timestamp subtraction. UNPROVEN; pinned
against Node/V8 (`lean/experiments/walk-anchors-refs.mts`).
-/

namespace Verified.Geo.WalkAnchors

abbrev Mode := String

/-- A vertex of a snapped rail track — the shared drawn-path vertex. -/
abbrev SPt := Verified.Geo.PathPt

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- A known endpoint with the confidence to attach to it. -/
structure WalkAnchor where
  lat : Float
  lon : Float
  sigmaM : Float
  deriving Inhabited, BEq, Repr

def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Beyond this a neighbour no longer testifies about the walk's endpoint. -/
def ANCHOR_MAX_GAP_S : Int := 180
/-- A snapped track's terminal vertex sits at the station to ~platform
precision. -/
def STATION_ANCHOR_SIGMA_M : Float := 15
/-- A stay centroid is softer: a poor-GPS indoor stay's centroid can itself be
biased by the very smear these anchors exist to correct (#244). -/
def STAY_ANCHOR_SIGMA_M : Float := 25

/-- Which end of the NEIGHBOUR touches the walk. `end` means the walk FOLLOWS
it (take its end coordinate); `start` means the walk precedes it. -/
inductive Side where
  | «end»
  | start
  deriving Inhabited, BEq, Repr

/-- The anchor a neighbouring segment contributes, or `none` when it has nothing
confident to say — too far away in time, a stay with no centroid, a train with
no snapped track (or one too short to have two ends), or any other mode. -/
def neighborAnchor (n? : Option Seg) (side : Side) (walkTs : Int) : Option WalkAnchor :=
  match n? with
  | none => none
  | some n =>
    let gapS := match side with
      | .«end» => walkTs - n.endTs
      | .start => n.startTs - walkTs
    if gapS > ANCHOR_MAX_GAP_S then none
    else
      let mode := effectiveMode n
      match mode, n.centroidLat, n.centroidLon with
      | "stationary", some la, some lo => some ⟨la, lo, STAY_ANCHOR_SIGMA_M⟩
      | _, _, _ =>
        let track := n.snappedPath.getD #[]
        if mode == "train" && track.size ≥ 2 then
          let p := match side with
            | .«end» => track[track.size - 1]!
            | .start => track[0]!
          some ⟨p.lat, p.lon, STATION_ANCHOR_SIGMA_M⟩
        else none

/-- Both endpoint anchors for the walking segment at index `i`. -/
def walkEndpointAnchors (segments : Array Seg) (i : Nat) : Option WalkAnchor × Option WalkAnchor :=
  -- `i - 1` truncates to 0 on `Nat`, so at index 0 the "previous" segment would
  -- be the walk ITSELF, where the TS gets `undefined` from `segments[-1]`.
  -- Guarded explicitly. No `#guard` can catch its removal, and that is not a
  -- gap: this is only ever called on a WALKING leg, and a walk anchoring to
  -- itself falls through every arm (no centroid, not a train) to `none`. The
  -- guard is kept because the equivalence depends on the caller, not on this
  -- function.
  let prev? := if i == 0 then none else segments[i - 1]?
  (neighborAnchor prev? .«end» segments[i]!.startTs,
   neighborAnchor segments[i + 1]? .start segments[i]!.endTs)

/-! ## Guards (V8 reference values) -/

private def TRACK : Array SPt := #[⟨51.5, -0.1, 0⟩, ⟨51.51, -0.11, 300⟩, ⟨51.52, -0.12, 600⟩]
private def stay (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "stationary", centroidLat := some 51.4, centroidLon := some (-0.2) }
private def train (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "train", snappedPath := some TRACK }
private def walk : Seg := { startTs := 1000, endTs := 2000, mode := "walking" }

private def STAY_A : Option WalkAnchor := some ⟨51.4, -0.2, 25⟩
private def TRACK_FIRST : Option WalkAnchor := some ⟨51.5, -0.1, 15⟩
private def TRACK_LAST : Option WalkAnchor := some ⟨51.52, -0.12, 15⟩

-- A stay before and a train after: the stay gives its centroid at the softer
-- sigma, the train its FIRST vertex — the walk precedes it.
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2000 3000] 1 == (STAY_A, TRACK_FIRST)
-- Mirror image: the train is BEFORE, so its LAST vertex is the one touching.
#guard walkEndpointAnchors #[train 0 1000, walk, stay 2000 3000] 1 == (TRACK_LAST, STAY_A)
-- 181 s is past the bar on the left; 180 exactly still testifies.
#guard walkEndpointAnchors #[stay 0 819, walk, train 2000 3000] 1 == (none, TRACK_FIRST)
#guard walkEndpointAnchors #[stay 0 820, walk, train 2000 3000] 1 == (STAY_A, TRACK_FIRST)
-- …and the same bar on the right.
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2181 3000] 1 == (STAY_A, none)
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2180 3000] 1 == (STAY_A, TRACK_FIRST)
-- A NEGATIVE gap — the neighbour overlaps the walk — is well under the bar, so
-- it testifies. The test is one-sided.
#guard walkEndpointAnchors #[stay 0 1500, walk, train 2000 3000] 1 == (STAY_A, TRACK_FIRST)
-- A stay with no centroid, a train with no track, and a track too short to have
-- two ends: nothing confident to say.
#guard walkEndpointAnchors
  #[{ startTs := 0, endTs := 1000, mode := "stationary" }, walk, train 2000 3000] 1 == (none, TRACK_FIRST)
#guard walkEndpointAnchors
  #[stay 0 1000, walk, { startTs := 2000, endTs := 3000, mode := "train" }] 1 == (STAY_A, none)
#guard walkEndpointAnchors
  #[stay 0 1000, walk, { startTs := 2000, endTs := 3000, mode := "train", snappedPath := some #[TRACK[0]!] }] 1
  == (STAY_A, none)
-- Neither mode contributes: a walk between two walks is unanchored.
#guard walkEndpointAnchors
  #[{ startTs := 0, endTs := 1000, mode := "walking" }, walk,
    { startTs := 2000, endTs := 3000, mode := "walking" }] 1 == (none, none)
-- effectiveMode: a leg refined TO stationary contributes its centroid…
#guard walkEndpointAnchors
  #[{ startTs := 0, endTs := 1000, mode := "walking", refinedMode := some "stationary",
      centroidLat := some 51.4, centroidLon := some (-0.2) }, walk, train 2000 3000] 1
  == (STAY_A, TRACK_FIRST)
-- …and one refined AWAY from train does not contribute its track.
#guard walkEndpointAnchors
  #[stay 0 1000, walk,
    { startTs := 2000, endTs := 3000, mode := "train", refinedMode := some "walking",
      snappedPath := some TRACK }] 1 == (STAY_A, none)
-- No neighbour on either side.
#guard walkEndpointAnchors #[walk] 0 == (none, none)

end Verified.Geo.WalkAnchors
