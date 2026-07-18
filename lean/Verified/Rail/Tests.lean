import Verified.Rail.Dijkstra

/-!
# `#guard` parity: Dijkstra vs the exhaustive oracle

Every check runs inside `lake build`. The oracle enumerates all simple
paths, so instances stay tiny (like the HSMM oracle guards). Checked per
seeded random graph: the port and the oracle agree on reachability, the
port's settled distance equals the oracle minimum, and the returned path
is a well-formed `src → dst` path attaining exactly that cost.
-/

namespace Verified.Rail.Tests

open Verified.Rail

private def lcg (s : Nat) : Nat := (s * 1103515245 + 12345) % 2147483648

/-- Seeded undirected multigraph: `n` vertices, `m` edge insertions
(self-loops skipped, parallels allowed — mirroring the TS builder). -/
private def mkG (seed n m : Nat) : Graph := Id.run do
  let mut adj : Array (Array (Nat × Nat)) := Array.replicate n #[]
  let mut s := lcg (seed + 1)
  for _ in [0:m] do
    let a := s % n
    s := lcg s
    let b := s % n
    s := lcg s
    let w := s % 1000 + 1
    s := lcg s
    if a ≠ b then
      adj := adj.setIfInBounds a ((adj.getD a #[]).push (b, w))
      adj := adj.setIfInBounds b ((adj.getD b #[]).push (a, w))
  return ⟨adj⟩

/-- One src/dst check: reachability agrees; on `some`, the settled
distance is the oracle minimum and the path is valid and attains it. -/
private def check (g : Graph) (src dst : Nat) : Bool :=
  match dijkstra g src dst, oracleDist g src dst with
  | none, none => true
  | some p, some c =>
    dijkstraDist g src dst == some c
      && isValidPath g src dst p
      && pathCost g p == some c
  | _, _ => false

private def checkAll (seed n m : Nat) : Bool := Id.run do
  let g := mkG seed n m
  for src in [0:n] do
    for dst in [0:n] do
      if !check g src dst then return false
  return true

#guard (List.range 8).all fun seed => checkAll seed 6 9
#guard (List.range 6).all fun seed => checkAll seed 5 4   -- sparse: disconnection common
#guard (List.range 4).all fun seed => checkAll seed 7 14  -- denser, parallel edges likely
#guard (List.range 4).all fun seed => checkAll seed 2 3   -- tiny with parallels

-- Degenerate shapes: empty graph; single vertex; src = dst; out of range.
#guard dijkstra ⟨#[]⟩ 0 0 == none
#guard dijkstra ⟨#[#[]]⟩ 0 0 == some [0]
#guard dijkstra (mkG 0 5 6) 2 2 == some [2]
#guard dijkstra (mkG 0 5 6) 0 7 == none

end Verified.Rail.Tests
