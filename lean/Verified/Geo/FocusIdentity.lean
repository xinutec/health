import Verified.Hsmm.FloatScore
/-!
# Focus-place identity across re-mining (port of `src/geo/focus-places-identity.ts`)

`refresh-focus-places` wipes and re-inserts every cluster nightly, so the
auto-increment id churns on every run. Anything that wants to reference a focus
place by id (HSMM `model_states`, `journey_patterns`) needs that id to survive.
`matchClusters` computes the mapping from newly-mined clusters to existing rows
by centroid overlap.

Greedy bipartite matching, which handles split and merge implicitly:

1. every `(old, new)` pair within `MATCH_RADIUS_M` becomes a candidate;
2. sorted closest-first, `firstSeenTs` ascending as the tiebreaker — on an exact
   distance tie the OLDER place keeps its identity;
3. walk the sorted list and accept a pair iff neither side is taken;
4. unassigned new clusters are fresh inserts, unassigned old ids are deletions.

Greedy is enough at the 5-30 clusters/user scale; the interface would survive a
swap to Hungarian.

The sort is STABLE in both languages (V8's `Array#sort` is TimSort, Lean's
`List.mergeSort` merges left-biased), so pairs equal on BOTH keys keep their
generation order — old-index outer, new-index inner.

Exactness: every decision is exact; `haversineMeters` (atan2) puts the radius
test at ≤ 1 ULP. UNPROVEN; pinned against Node/V8
(`lean/experiments/small-leaves-refs.mts`).
-/

namespace Verified.Geo.FocusIdentity

open Verified.Hsmm.FloatScore (haversineMeters)

/-- Max distance between an existing and a new cluster centroid for them to be
the same place. Sized to absorb the drift of a stable place's centroid when a
year of fixes is re-mined (10-50 m), plus the tail of a cluster that shifts a
city block as new fixes accumulate. -/
def MATCH_RADIUS_M : Float := 150

structure ExistingPlace where
  id : Int
  centroidLat : Float
  centroidLon : Float
  /-- When this cluster was first observed. The matching tiebreaker: equidistant
      matches go to the older place, preserving established identity over
      recently-created clusters. -/
  firstSeenTs : Int
  deriving Inhabited, BEq, Repr

structure NewCluster where
  centroidLat : Float
  centroidLon : Float
  deriving Inhabited, BEq, Repr

structure ClusterMatch where
  /-- Index into the `newClusters` array. -/
  newIndex : Nat
  /-- Existing `focus_places.id` this cluster identifies with; `none` for a
      fresh cluster, which gets a new id on INSERT. -/
  oldId : Option Int
  deriving Inhabited, BEq, Repr

structure MatchResult where
  /-- One entry per input new cluster, in input order. (`matches` is a
      RESERVED token in Lean, hence the rename from the TS field name.) -/
  assignments : Array ClusterMatch
  /-- Existing ids that matched nothing — rows to DELETE. -/
  deletedOldIds : Array Int
  deriving Inhabited, BEq, Repr

private structure CandidatePair where
  oldIndex : Nat
  newIndex : Nat
  distanceM : Float
  firstSeenTs : Int
  deriving Inhabited, BEq, Repr

def matchClusters (oldClusters : Array ExistingPlace) (newClusters : Array NewCluster) : MatchResult :=
  -- Every (old, new) within radius, generated old-outer / new-inner.
  let pairs : List CandidatePair :=
    (List.range oldClusters.size).flatMap fun i =>
      (List.range newClusters.size).filterMap fun j =>
        let o := oldClusters[i]!
        let n := newClusters[j]!
        let d := haversineMeters o.centroidLat o.centroidLon n.centroidLat n.centroidLon
        if d ≤ MATCH_RADIUS_M then some ⟨i, j, d, o.firstSeenTs⟩ else none
  -- Closest first, older existing place as tiebreaker. Ties on both keys keep
  -- generation order (stable merge).
  let sorted := pairs.mergeSort fun a b =>
    if a.distanceM != b.distanceM then a.distanceM < b.distanceM else a.firstSeenTs ≤ b.firstSeenTs
  -- Greedy: accept a pair iff neither side is already assigned.
  let (assignedOld, assignedNew) :=
    sorted.foldl (init := (([] : List Nat), ([] : List (Nat × Int)))) fun (aOld, aNew) p =>
      if aOld.contains p.oldIndex || aNew.any (·.1 == p.newIndex) then (aOld, aNew)
      else (p.oldIndex :: aOld, (p.newIndex, oldClusters[p.oldIndex]!.id) :: aNew)
  { assignments := (Array.range newClusters.size).map fun j =>
      ⟨j, (assignedNew.find? (·.1 == j)).map (·.2)⟩
    deletedOldIds := (Array.range oldClusters.size).filterMap fun i =>
      if assignedOld.contains i then none else some oldClusters[i]!.id }

/-! ## Guards (V8 reference values) -/

private def OLD : Array ExistingPlace :=
  #[⟨10, 51.52, -0.13, 1000⟩, ⟨11, 51.53, -0.13, 2000⟩, ⟨12, 51.7, 0.4, 500⟩]

private def mv (r : MatchResult) : Array (Option Int) × Array Int :=
  (r.assignments.map (·.oldId), r.deletedOldIds)

-- One-to-one: two survive, the far one is deleted.
#guard mv (matchClusters OLD #[⟨51.5201, -0.1301⟩, ⟨51.5299, -0.13⟩])
  == (#[some 10, some 11], #[12])
-- SPLIT: one old place, two new clusters in range. Greedy takes the CLOSER
-- (index 1), so index 0 falls through to a fresh insert — the order of the
-- output is input order, not match order.
#guard mv (matchClusters #[OLD[0]!] #[⟨51.5205, -0.13⟩, ⟨51.5201, -0.13⟩])
  == (#[none, some 10], #[])
-- MERGE: two old places, one new cluster between them. The nearer id survives.
#guard mv (matchClusters #[OLD[0]!, ⟨11, 51.5210, -0.13, 2000⟩] #[⟨51.5205, -0.13⟩])
  == (#[some 10], #[11])
-- TIEBREAK: the secondary key is observable only on an EXACT float tie, so the
-- two old places sit on the SAME coordinates and the older `firstSeenTs` wins.
-- (Mirroring them north/south does NOT produce a tie — see the guard below.)
#guard mv (matchClusters #[⟨20, 51.5201, -0.13, 9000⟩, ⟨21, 51.5201, -0.13, 1⟩] #[⟨51.52, -0.13⟩])
  == (#[some 21], #[20])
-- Reversed, to prove the winner is the OLDER place rather than simply the
-- first-generated pair (which a stable sort alone would also give).
#guard mv (matchClusters #[⟨20, 51.5201, -0.13, 1⟩, ⟨21, 51.5201, -0.13, 9000⟩] #[⟨51.52, -0.13⟩])
  == (#[some 20], #[21])
-- Same coords AND same age: a total tie, so the stable sort's generation order
-- (old-index outer) decides and the FIRST old id wins.
#guard mv (matchClusters #[⟨20, 51.5201, -0.13, 500⟩, ⟨21, 51.5201, -0.13, 500⟩] #[⟨51.52, -0.13⟩])
  == (#[some 20], #[21])
-- The near-mirror is NOT a tie: `51.5205 - 51.52` and `51.52 - 51.5195` are
-- different doubles (55.59746332175475 m vs 55.59746332254485 m), so this pair
-- is decided on DISTANCE and the younger place wins by being barely closer.
-- Recorded because it is the case I first mistook for the tiebreaker.
#guard mv (matchClusters #[⟨20, 51.5205, -0.13, 9000⟩, ⟨21, 51.5195, -0.13, 1⟩] #[⟨51.52, -0.13⟩])
  == (#[some 20], #[21])
-- Everything out of radius: all new, all old deleted.
#guard mv (matchClusters OLD #[⟨40, 0⟩]) == (#[none], #[10, 11, 12])
-- EXACTLY 150 m apart: the test is `d ≤ radius`, so the boundary MATCHES. Same
-- story as the presence radius in `Verified.Geo.CurrentPlace` — found by search,
-- because the doubles either side of 150.0 differ by ~8e-10 m.
#guard mv (matchClusters #[⟨30, 51.52, -0.13, 1⟩] #[⟨51.5213489816655, -0.129997724⟩])
  == (#[some 30], #[])
#guard mv (matchClusters #[] #[⟨51.52, -0.13⟩]) == (#[none], #[])
#guard mv (matchClusters OLD #[]) == (#[], #[10, 11, 12])

end Verified.Geo.FocusIdentity
