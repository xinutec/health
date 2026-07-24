import Std.Data.HashMap
import Std.Data.HashSet
/-!
# Per-line route connectivity (implementation-first port of `pathExistsOnLine`)

Route-rail's `connected` fact: does a path of edges ALL carrying line `L` join
the fixes near the boarding platform to those near the alighting platform? A BFS
in the subgraph of `L`-only edges, over the node adjacency the route graph
already indexes (two edges share a node iff their endpoints collapse to the same
`nodeKey`). Capped at `MAX_BFS_EDGES` to bound cost.

Pure graph traversal — no floats, so EXACT. The adjacency (node ids, incident
edges) is resolved by the graph builder and passed in; the BFS is opaque over
string ids, so the `nodeKey` `toFixed` rounding stays with the builder. The Bool
result is traversal-order-independent (reachability), so fidelity needs only the
adjacency + line filter + the cap, not a specific visit order. UNPROVEN; pinned
by the `#guard`s.
-/

namespace Verified.Hsmm.RouteConnectivity

open Std (HashMap HashSet)

/-- Cap on BFS exploration (matches the TS `MAX_BFS_EDGES`). -/
def MAX_BFS_EDGES : Nat := 1000

/-- The `L`-only reachability view of the route graph: per-edge endpoint node
    ids and line memberships, and per-node incident edge ids. -/
structure Graph where
  endpoints : HashMap String (List String)
  lines : HashMap String (List String)
  nodeEdges : HashMap String (List String)

/-- BFS worklist step: process the queue front, enqueuing unvisited `L`-edges
    reachable through its endpoints; short-circuit on reaching a goal edge.
    Bounded by the visited cap. -/
partial def bfs (g : Graph) (line : String) (goal : HashSet String) :
    List String → HashSet String → Bool
  | [], _ => false
  | edgeId :: rest, visited =>
    if visited.size ≥ MAX_BFS_EDGES then false
    else
      let neighbors := (g.endpoints.getD edgeId []).flatMap (fun n => g.nodeEdges.getD n [])
      let step := neighbors.foldl (fun (acc : Bool × List String × HashSet String) adjId =>
        let (found, q, vis) := acc
        if found then acc
        else if vis.contains adjId then acc
        else if !(g.lines.getD adjId []).contains line then acc
        else if goal.contains adjId then (true, q, vis)
        else (false, q ++ [adjId], vis.insert adjId)) (false, [], visited)
      let (found, additions, visited') := step
      if found then true else bfs g line goal (rest ++ additions) visited'

/-- True iff some path of `line`-only edges joins `startEdges` to `goalEdges`. -/
def pathExistsOnLine (g : Graph) (line : String) (startEdges goalEdges : List String) : Bool :=
  if startEdges.isEmpty || goalEdges.isEmpty then false
  else
    let goal : HashSet String := goalEdges.foldl (·.insert ·) {}
    if startEdges.any (goal.contains ·) then true
    else bfs g line goal startEdges (startEdges.foldl (·.insert ·) {})

private def mkMap {α : Type} (pairs : List (String × α)) : HashMap String α :=
  pairs.foldl (fun m (k, v) => m.insert k v) {}

-- A chain e1—e2—e3 on line "L", a branch e4 on "M" off node n2, and an isolated
-- e5 on "L". Adjacency is the shared-node index the graph builder produces.
private def g : Graph := {
  endpoints := mkMap [("e1", ["n1", "n2"]), ("e2", ["n2", "n3"]), ("e3", ["n3", "n4"]),
                      ("e4", ["n2", "n5"]), ("e5", ["n6", "n7"])],
  lines := mkMap [("e1", ["L"]), ("e2", ["L"]), ("e3", ["L"]), ("e4", ["M"]), ("e5", ["L"])],
  nodeEdges := mkMap [("n1", ["e1"]), ("n2", ["e1", "e2", "e4"]), ("n3", ["e2", "e3"]),
                      ("n4", ["e3"]), ("n5", ["e4"]), ("n6", ["e5"]), ("n7", ["e5"])] }

#guard pathExistsOnLine g "L" ["e1"] ["e3"] == true   -- e1→e2→e3, all on L
#guard pathExistsOnLine g "L" ["e1"] ["e1"] == true   -- start∩goal overlap
#guard pathExistsOnLine g "L" ["e1"] ["e5"] == false  -- e5 isolated
#guard pathExistsOnLine g "M" ["e1"] ["e3"] == false  -- no M path from e1 to e3
#guard pathExistsOnLine g "L" ["e2"] ["e4"] == false  -- e4 is on M, not L
#guard pathExistsOnLine g "L" [] ["e3"] == false      -- empty start
#guard pathExistsOnLine g "L" ["e3"] ["e1"] == true   -- symmetric

end Verified.Hsmm.RouteConnectivity
