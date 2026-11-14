import Verified.Geo.SegmentMerge
import Verified.Geo.PathPoint
/-!
# Walk endpoint anchors

A walking leg's endpoints are often known from its neighbours: an adjacent
stay's centroid, or a train's snapped terminal vertex at the station. These pin
the reconstruction against a post-tunnel reacquire smear.

Only a neighbour within three minutes testifies; across a longer gap the
endpoint is unknown. The test is one-sided (`> 180`), so an overlapping
neighbour still counts.

Exact. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.WalkAnchors

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

-- `refinedMode ?? mode` — `SegmentMerge.effectiveMode`, the one definition.
export Verified.Geo.SegmentMerge (effectiveMode)

/-- Beyond this a neighbour no longer testifies about the walk's endpoint. -/
def ANCHOR_MAX_GAP_S : Int := 180
/-- A snapped track's terminal vertex sits at the station to ~platform
precision. -/
def STATION_ANCHOR_SIGMA_M : Float := 15
/-- A stay centroid is softer: a poor-GPS indoor stay's centroid can itself be
biased by the very smear these anchors exist to correct. -/
def STAY_ANCHOR_SIGMA_M : Float := 25

/-- Which end of the neighbour touches the walk. `end` means the walk follows
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
        let p? := if mode == "train" && track.size ≥ 2 then
            (match side with
              | .«end» => track.back?
              | .start => track[0]?)
          else none
        p?.map fun p => ⟨p.lat, p.lon, STATION_ANCHOR_SIGMA_M⟩

/-- Both endpoint anchors for the walking segment at index `i`. -/
def walkEndpointAnchors (segments : Array Seg) (i : Nat) : Option WalkAnchor × Option WalkAnchor :=
  -- `i - 1` truncates to 0 on `Nat`, so index 0 is guarded explicitly. No
  -- guard can tell (a walk anchored to itself falls through to `none`), but
  -- that depends on the caller.
  let prev? := if i == 0 then none else segments[i - 1]?
  match segments[i]? with
  | none => (none, none)  -- no walk, no anchors
  | some walk =>
    (neighborAnchor prev? .«end» walk.startTs,
     neighborAnchor segments[i + 1]? .start walk.endTs)

/-! ## Guards -/

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
-- sigma, the train its first vertex — the walk precedes it.
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2000 3000] 1 == (STAY_A, TRACK_FIRST)
-- Mirror image: the train is before, so its last vertex is the one touching.
#guard walkEndpointAnchors #[train 0 1000, walk, stay 2000 3000] 1 == (TRACK_LAST, STAY_A)
-- 181 s is past the bar on the left; 180 exactly still testifies.
#guard walkEndpointAnchors #[stay 0 819, walk, train 2000 3000] 1 == (none, TRACK_FIRST)
#guard walkEndpointAnchors #[stay 0 820, walk, train 2000 3000] 1 == (STAY_A, TRACK_FIRST)
-- …and the same bar on the right.
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2181 3000] 1 == (STAY_A, none)
#guard walkEndpointAnchors #[stay 0 1000, walk, train 2180 3000] 1 == (STAY_A, TRACK_FIRST)
-- A negative gap — the neighbour overlaps the walk — is well under the bar, so
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
-- effectiveMode: a leg refined to stationary contributes its centroid…
#guard walkEndpointAnchors
  #[{ startTs := 0, endTs := 1000, mode := "walking", refinedMode := some "stationary",
      centroidLat := some 51.4, centroidLon := some (-0.2) }, walk, train 2000 3000] 1
  == (STAY_A, TRACK_FIRST)
-- …and one refined away from train does not contribute its track.
#guard walkEndpointAnchors
  #[stay 0 1000, walk,
    { startTs := 2000, endTs := 3000, mode := "train", refinedMode := some "walking",
      snappedPath := some TRACK }] 1 == (STAY_A, none)
-- No neighbour on either side.
#guard walkEndpointAnchors #[walk] 0 == (none, none)

end Verified.Geo.WalkAnchors
