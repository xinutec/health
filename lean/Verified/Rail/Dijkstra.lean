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

def siftUp (a : Array (Nat × Nat)) (i : Nat) : Array (Nat × Nat) :=
  if _h : i = 0 then a
  else
    if (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD i (0, 0)).1 then a
    else
      siftUp
        ((a.setIfInBounds i (a.getD ((i - 1) / 2) (0, 0))).setIfInBounds ((i - 1) / 2)
          (a.getD i (0, 0)))
        ((i - 1) / 2)
  termination_by i
  decreasing_by omega

def push (h : Heap) (p v : Nat) : Heap :=
  let a := h.a.push (p, v)
  ⟨siftUp a (a.size - 1)⟩

/-- The left-child step of the TS sift-down selection: the smaller of
`i` and its left child (left preferred on ties by strict `<`). -/
def sDown1 (a : Array (Nat × Nat)) (i : Nat) : Nat :=
  if 2 * i + 1 < a.size && (a.getD (2 * i + 1) (0, 0)).1 < (a.getD i (0, 0)).1 then
    2 * i + 1
  else i

/-- The full sift-down selection: the smallest of `i` and its children. -/
def sDown (a : Array (Nat × Nat)) (i : Nat) : Nat :=
  if 2 * i + 2 < a.size && (a.getD (2 * i + 2) (0, 0)).1 < (a.getD (sDown1 a i) (0, 0)).1 then
    2 * i + 2
  else sDown1 a i

def siftDown (a : Array (Nat × Nat)) : Nat → Nat → Array (Nat × Nat)
  | 0, _ => a
  | fuel + 1, i =>
    if sDown a i = i then a
    else
      siftDown
        ((a.setIfInBounds i (a.getD (sDown a i) (0, 0))).setIfInBounds (sDown a i)
          (a.getD i (0, 0)))
        fuel (sDown a i)

/-- Pop the minimum. Mirrors TS: move the last element to the root and
sift down (skipped when the heap becomes empty). -/
def pop (h : Heap) : Option ((Nat × Nat) × Heap) :=
  match h.a[0]? with
  | none => none
  | some top =>
    if h.a.pop.size > 0 then
      some (top, ⟨siftDown (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0)))
        (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0))).size 0⟩)
    else some (top, ⟨h.a.pop⟩)

end Heap

/-- Dijkstra working state. `dist[v] = none` is `+∞`; `prev[v] = n` is the
TS `-1` sentinel. -/
structure DState where
  dist : Array (Option Nat)
  prev : Array Nat
  done : Array Bool
  heap : Heap

/-- The TS `nd < (dist[v] ?? Infinity)`. -/
def improves (st : DState) (v nd : Nat) : Bool :=
  match st.dist.getD v none with
  | none => true
  | some dv => nd < dv

/-- One edge relaxation — the body of the TS inner loop, strict `<`. -/
def relaxStep (u p : Nat) (st : DState) (tw : Nat × Nat) : DState :=
  if improves st tw.1 (p + tw.2) then
    { st with
      dist := st.dist.setIfInBounds tw.1 (some (p + tw.2))
      prev := st.prev.setIfInBounds tw.1 u
      heap := st.heap.push (p + tw.2) tw.1 }
  else st

/-- Relax every edge out of `u` (settled at distance `p`), in adjacency
order — the TS inner loop. -/
def relaxAll (u p : Nat) (edges : Array (Nat × Nat)) (st : DState) : DState :=
  edges.foldl (init := st) (relaxStep u p)

def loop (g : Graph) (dst : Nat) : Nat → DState → DState
  | 0, st => st
  | fuel + 1, st =>
    match st.heap.pop with
    | none => st
    | some ((p, u), h') =>
      if st.done.getD u false then loop g dst fuel { st with heap := h' }
      else if u = dst then
        { st with heap := h', done := st.done.setIfInBounds u true }
      else
        loop g dst fuel
          (relaxAll u p (g.adj.getD u #[])
            { st with heap := h', done := st.done.setIfInBounds u true })

/-- Follow `prev` from `dst` back to the sentinel, accumulating the path
front-first (the TS builds reversed and flips; same result). -/
def rebuild (prev : Array Nat) (n : Nat) : Nat → Nat → List Nat → Option (List Nat)
  | 0, _, _ => none
  | fuel + 1, v, acc =>
    let pv := prev.getD v n
    if pv = n then some (v :: acc)
    else rebuild prev n fuel pv (v :: acc)

/-- Run the search to completion and return the final working state —
the substrate both `dijkstra` and the certified wrapper read from. -/
def dijkstraSt (g : Graph) (src dst : Nat) : DState :=
  let n := g.n
  let st0 : DState := {
    dist := (Array.replicate n none).setIfInBounds src (some 0)
    prev := Array.replicate n n
    done := Array.replicate n false
    heap := Heap.push ⟨#[]⟩ 0 src }
  let fuel := g.adj.foldl (fun acc r => acc + r.size) 0 + n + 2
  loop g dst fuel st0

/-- Shortest path `src → dst` as a vertex sequence, `none` when
disconnected (or endpoints out of range). -/
def dijkstra (g : Graph) (src dst : Nat) : Option (List Nat) :=
  let n := g.n
  if src ≥ n ∨ dst ≥ n then none
  else
    let st := dijkstraSt g src dst
    match st.dist.getD dst none with
    | none => none
    | some _ => rebuild st.prev n (n + 1) dst []

/-- The settled distance to `dst`, for spec checks. -/
def dijkstraDist (g : Graph) (src dst : Nat) : Option Nat :=
  let n := g.n
  if src ≥ n ∨ dst ≥ n then none
  else (dijkstraSt g src dst).dist.getD dst none

end Verified.Rail
