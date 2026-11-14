/-!
# Rail graph: spec substrate for the verified shortest path

A rail graph with ×2²⁰-quantised `Nat` weights (≤ ~2^35 on real corridors).
The served snapper (`Geo.RailSnap`) builds and searches its own float graph;
nothing feeds this one at runtime. `Verified.Geo.Lazy*` reuse its definitions.

`oracleDist` is the exhaustive spec: the cheapest simple path. Exponential,
`#guard`-scale only.
-/

namespace Verified.Rail

/-- Weighted directed adjacency: `adj[u]` lists `(v, w)`. Nothing relies on
symmetry; parallel edges may occur, and path cost uses the cheapest. -/
structure Graph where
  adj : Array (Array (Nat × Nat))
deriving Repr, Inhabited

def Graph.n (g : Graph) : Nat := g.adj.size

/-- Cheapest direct edge `u → v`, `none` when there is no such edge. -/
def edgeMinW (g : Graph) (u v : Nat) : Option Nat :=
  (g.adj.getD u #[]).foldl (init := none) fun acc tw =>
    if tw.1 = v then
      match acc with
      | none => some tw.2
      | some w => some (Nat.min w tw.2)
    else acc

/-- Cost of a vertex sequence: sum of cheapest consecutive edges; `none`
if some consecutive pair is not an edge or the list is empty. -/
def pathCost (g : Graph) : List Nat → Option Nat
  | [] => none
  | [_] => some 0
  | a :: b :: rest => do
    let w ← edgeMinW g a b
    let c ← pathCost g (b :: rest)
    return w + c

/-- A well-formed `src → dst` result: nonempty, right endpoints, every
step an edge. -/
def isValidPath (g : Graph) (src dst : Nat) (p : List Nat) : Bool :=
  match p with
  | [] => false
  | v :: _ =>
    v == src && p.getLast! == dst && (pathCost g p).isSome

/-- Costs of every simple `cur → dst` path (visited-set DFS; `fuel`
bounds depth — `n+1` covers every simple path). -/
def simplePathCosts (g : Graph) (dst : Nat) : Nat → Nat → List Nat → List Nat
  | 0, _, _ => []
  | fuel + 1, cur, visited =>
    if cur = dst then [0]
    else
      (g.adj.getD cur #[]).toList.flatMap fun tw =>
        if visited.contains tw.1 then []
        else (simplePathCosts g dst fuel tw.1 (tw.1 :: visited)).map (tw.2 + ·)

/-- The spec: minimum cost over all simple `src → dst` paths, `none` when
disconnected. (Nonnegative weights ⇒ some shortest walk is simple, so
"over simple paths" loses nothing.) -/
def oracleDist (g : Graph) (src dst : Nat) : Option Nat :=
  match simplePathCosts g dst (g.n + 1) src [src] with
  | [] => none
  | c :: cs => some (cs.foldl Nat.min c)

end Verified.Rail
