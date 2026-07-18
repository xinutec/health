import Verified.Rail.Graph

/-!
# Dijkstra — a faithful port of `rail-snap.ts`'s `shortestPath`

Ported loop-for-loop from the TS implementation, including its tie
behaviour, so path identity (not just path cost) can be pinned against the
production code on identical quantised graphs:

* the binary min-heap sifts up while `parent > child` (stops on `≤`) and
  sifts down only to a strictly smaller child, left child preferred on
  ties;
* the main loop lazily skips settled vertices, marks a vertex done before
  the early exit at `dst`, and relaxes edges in adjacency order with
  strict `<`;
* the path is rebuilt by following `prev` from `dst` to the `-1` sentinel
  (here `n`).

Two deliberate contract deltas, both "honest `none` over nonsense":
out-of-range `src`/`dst` returns `none` (the TS code would read past its
arrays), and a `prev` cycle — impossible for a real run — exhausts fuel to
`none` instead of looping.

Fuel is not a semantic knob: each pop consumes a push, and pushes are
bounded by one per directed edge (a vertex settles once) plus the seed, so
`E + n + 2` never exhausts on a real run.
-/

namespace Verified.Rail

/-- Binary min-heap of `(priority, vertex)` — the TS `MinHeap`. -/
structure Heap where
  a : Array (Nat × Nat)
deriving Repr, Inhabited

namespace Heap

def size (h : Heap) : Nat := h.a.size

private def siftUp (a : Array (Nat × Nat)) (i : Nat) : Array (Nat × Nat) :=
  if _h : i = 0 then a
  else
    let parent := (i - 1) / 2
    if (a.getD parent (0, 0)).1 ≤ (a.getD i (0, 0)).1 then a
    else
      let x := a.getD i (0, 0)
      let y := a.getD parent (0, 0)
      siftUp ((a.setIfInBounds i y).setIfInBounds parent x) parent
  termination_by i
  decreasing_by omega

def push (h : Heap) (p v : Nat) : Heap :=
  let a := h.a.push (p, v)
  ⟨siftUp a (a.size - 1)⟩

private def siftDown (a : Array (Nat × Nat)) : Nat → Nat → Array (Nat × Nat)
  | 0, _ => a
  | fuel + 1, i =>
    let l := 2 * i + 1
    let r := 2 * i + 2
    let s := if l < a.size && (a.getD l (0, 0)).1 < (a.getD i (0, 0)).1 then l else i
    let s := if r < a.size && (a.getD r (0, 0)).1 < (a.getD s (0, 0)).1 then r else s
    if s = i then a
    else
      let x := a.getD i (0, 0)
      let y := a.getD s (0, 0)
      siftDown ((a.setIfInBounds i y).setIfInBounds s x) fuel s

/-- Pop the minimum. Mirrors TS: move the last element to the root and
sift down (skipped when the heap becomes empty). -/
def pop (h : Heap) : Option ((Nat × Nat) × Heap) :=
  match h.a[0]? with
  | none => none
  | some top =>
    let last := h.a.getD (h.a.size - 1) (0, 0)
    let a' := h.a.pop
    if a'.size > 0 then
      let a'' := a'.setIfInBounds 0 last
      some (top, ⟨siftDown a'' a''.size 0⟩)
    else some (top, ⟨a'⟩)

end Heap

/-- Dijkstra working state. `dist[v] = none` is `+∞`; `prev[v] = n` is the
TS `-1` sentinel. -/
structure DState where
  dist : Array (Option Nat)
  prev : Array Nat
  done : Array Bool
  heap : Heap

/-- Relax every edge out of `u` (settled at distance `p`), in adjacency
order, strict `<` — the TS inner loop. -/
private def relaxAll (u p : Nat) (edges : Array (Nat × Nat)) (st : DState) : DState :=
  edges.foldl (init := st) fun st tw =>
    let nd := p + tw.2
    let better := match st.dist.getD tw.1 none with
      | none => true
      | some dv => nd < dv
    if better then
      { st with
        dist := st.dist.setIfInBounds tw.1 (some nd)
        prev := st.prev.setIfInBounds tw.1 u
        heap := st.heap.push nd tw.1 }
    else st

private def loop (g : Graph) (dst : Nat) : Nat → DState → DState
  | 0, st => st
  | fuel + 1, st =>
    match st.heap.pop with
    | none => st
    | some ((p, u), h') =>
      let st := { st with heap := h' }
      if st.done.getD u false then loop g dst fuel st
      else
        let st := { st with done := st.done.setIfInBounds u true }
        if u = dst then st
        else loop g dst fuel (relaxAll u p (g.adj.getD u #[]) st)

/-- Follow `prev` from `dst` back to the sentinel, accumulating the path
front-first (the TS builds reversed and flips; same result). -/
private def rebuild (prev : Array Nat) (n : Nat) : Nat → Nat → List Nat → Option (List Nat)
  | 0, _, _ => none
  | fuel + 1, v, acc =>
    let pv := prev.getD v n
    if pv = n then some (v :: acc)
    else rebuild prev n fuel pv (v :: acc)

/-- Shortest path `src → dst` as a vertex sequence, `none` when
disconnected (or endpoints out of range). -/
def dijkstra (g : Graph) (src dst : Nat) : Option (List Nat) :=
  let n := g.n
  if src ≥ n ∨ dst ≥ n then none
  else
    let st0 : DState := {
      dist := (Array.replicate n none).setIfInBounds src (some 0)
      prev := Array.replicate n n
      done := Array.replicate n false
      heap := Heap.push ⟨#[]⟩ 0 src }
    let fuel := g.adj.foldl (fun acc r => acc + r.size) 0 + n + 2
    let st := loop g dst fuel st0
    match st.dist.getD dst none with
    | none => none
    | some _ => rebuild st.prev n (n + 1) dst []

/-- The settled distance to `dst`, for spec checks. -/
def dijkstraDist (g : Graph) (src dst : Nat) : Option Nat :=
  let n := g.n
  if src ≥ n ∨ dst ≥ n then none
  else
    let st0 : DState := {
      dist := (Array.replicate n none).setIfInBounds src (some 0)
      prev := Array.replicate n n
      done := Array.replicate n false
      heap := Heap.push ⟨#[]⟩ 0 src }
    let fuel := g.adj.foldl (fun acc r => acc + r.size) 0 + n + 2
    (loop g dst fuel st0).dist.getD dst none

end Verified.Rail
