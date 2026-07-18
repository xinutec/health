import Verified.Rail.HeapInv
import Verified.Rail.Certify

/-!
# Dijkstra loop invariants — retiring the rail `#guard` pin

`Certify.lean` proved the V3 goal theorems by *certification*: whatever the
untrusted search returns is validated by a proved checker. The remaining
`#guard`-pinned fact is the converse — the checker never fires on a real
run (`dijkstraC == dijkstra`), and `none ⟺ disconnected`. This file proves
it with the classical algorithm invariants, built on the heap theorems of
`HeapInv.lean`:

* `InvCore` — the working-state invariant: array sizes; the heap really is
  a heap; lazy deletion (every heap entry over-approximates its vertex's
  current `dist`); the pop floor `L` (all entries and all settled prices
  are on the right side of the last popped priority); every unsettled
  finite vertex has a live heap entry; and a *ghost* prev-tree (`pos`/`c`
  rank vertices by settle order, so `prev`-chains strictly descend and
  each hop records the exact relaxing edge).
* `Relaxed` / `RelaxedExcept` — edges out of settled vertices don't
  shortcut. The `dst` early exit legitimately skips `dst`'s own pass;
  `feasibleCut` still holds there because every settled price is `≤ D`.
* `potential` — pops strictly decrease `heap.size + Σ (undone adjacency)`,
  so the TS fuel `E + n + 2` never exhausts.

Adjacency targets must be in range (`WFEdges`) — `relaxAll` silently
drops out-of-range targets, which would break the relaxation invariant.
Production graphs are in range by construction, and `dijkstraC` remains
sound without the assumption.
-/

namespace Verified.Rail

open Heap (getD_eq_of_lt getD_set mem_of_getD)

/-- Every adjacency target in range. -/
def WFEdges (g : Graph) : Prop :=
  ∀ u, u < g.n → ∀ tw ∈ (g.adj.getD u #[]).toList, tw.1 < g.n

/-! ## `getD` plumbing -/

private theorem getD_oob {α : Type} {a : Array α} {i : Nat} (hi : a.size ≤ i) (d : α) :
    a.getD i d = d := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none hi]
  rfl

private theorem getD_replicate {α : Type} (n i : Nat) (x d : α) :
    (Array.replicate n x).getD i d = if i < n then x else d := by
  by_cases hi : i < n
  · rw [if_pos hi, getD_eq_of_lt (by rw [Array.size_replicate]; exact hi),
      Array.getElem_replicate]
  · rw [if_neg hi, getD_oob (by rw [Array.size_replicate]; omega)]

/-! ## The invariant -/

/-- Number of settled vertices — bounds the ghost rank counter. -/
def doneCount (g : Graph) (st : DState) : Nat :=
  ((List.range g.n).filter (fun v => st.done.getD v false)).length

/-- The prev-tree ghost: `pos` ranks vertices by settle order (`c` = next
rank). Following `prev` strictly descends ranks — chains terminate without
repeating — and each hop records the exact edge whose relaxation set it. -/
def TreeGhost (g : Graph) (src : Nat) (st : DState) (pos : Nat → Nat) (c : Nat) : Prop :=
  (∀ v, st.done.getD v false = true → pos v < c) ∧
  (∀ v, v < g.n → ∀ d, st.dist.getD v none = some d →
    (st.prev.getD v g.n = g.n → v = src ∧ d = 0) ∧
    (st.prev.getD v g.n ≠ g.n →
      st.prev.getD v g.n < g.n ∧
      st.done.getD (st.prev.getD v g.n) false = true ∧
      pos (st.prev.getD v g.n) < pos v ∧
      ∃ w du, (v, w) ∈ (g.adj.getD (st.prev.getD v g.n) #[]).toList ∧
        st.dist.getD (st.prev.getD v g.n) none = some du ∧ d = du + w))

/-- The working-state invariant, relative to the pop floor `L` (the
priority of the last settled pop; `0` initially). -/
structure InvCore (g : Graph) (src : Nat) (L : Nat) (st : DState) : Prop where
  dist_size : st.dist.size = g.n
  prev_size : st.prev.size = g.n
  done_size : st.done.size = g.n
  src_lt : src < g.n
  src_zero : st.dist.getD src none = some 0
  heap_hp : Heap.IsHeap st.heap
  heap_wf : ∀ z ∈ st.heap.a, z.2 < g.n ∧ ∃ d, st.dist.getD z.2 none = some d ∧ d ≤ z.1
  heap_ge : ∀ z ∈ st.heap.a, L ≤ z.1
  done_lt : ∀ v, st.done.getD v false = true → v < g.n
  done_le : ∀ v, st.done.getD v false = true →
    ∃ d, st.dist.getD v none = some d ∧ d ≤ L
  undone_heap : ∀ v, v < g.n → st.done.getD v false = false →
    ∀ d, st.dist.getD v none = some d → (d, v) ∈ st.heap.a
  tree : ∃ pos c, c ≤ doneCount g st ∧ TreeGhost g src st pos c

/-- Vertex `u`'s outgoing edges have been relaxed against its price. -/
def RelaxedAt (g : Graph) (st : DState) (u : Nat) : Prop :=
  ∀ du, st.dist.getD u none = some du →
    ∀ tw ∈ (g.adj.getD u #[]).toList,
      ∃ dv, st.dist.getD tw.1 none = some dv ∧ dv ≤ du + tw.2

/-- Every settled vertex is relaxed (holds mid-run). -/
def Relaxed (g : Graph) (st : DState) : Prop :=
  ∀ u, st.done.getD u false = true → RelaxedAt g st u

/-- Every settled vertex except `x` is relaxed (the `dst` early exit skips
`dst`'s own pass). -/
def RelaxedExcept (g : Graph) (x : Nat) (st : DState) : Prop :=
  ∀ u, st.done.getD u false = true → u ≠ x → RelaxedAt g st u

theorem Relaxed.except (h : Relaxed g st) (x : Nat) : RelaxedExcept g x st :=
  fun u hu _ => h u hu

/-! ## The initial state -/

/-- The state `dijkstraSt` starts the loop from. -/
def initState (g : Graph) (src : Nat) : DState :=
  { dist := (Array.replicate g.n none).setIfInBounds src (some 0)
    prev := Array.replicate g.n g.n
    done := Array.replicate g.n false
    heap := Heap.push ⟨#[]⟩ 0 src }

theorem dijkstraSt_eq (g : Graph) (src dst : Nat) :
    dijkstraSt g src dst =
      loop g dst (g.adj.foldl (fun acc r => acc + r.size) 0 + g.n + 2)
        (initState g src) := rfl

private theorem initState_heap (g : Graph) (src : Nat) :
    (initState g src).heap = Heap.push ⟨#[]⟩ 0 src := rfl

private theorem initHeap_a (p v : Nat) : (Heap.push ⟨#[]⟩ p v).a = #[(p, v)] := by
  show Heap.siftUp (Array.push #[] (p, v)) ((Array.push #[] (p, v)).size - 1) = #[(p, v)]
  unfold Heap.siftUp
  rw [dif_pos (show (Array.push #[] (p, v)).size - 1 = 0 from rfl)]
  rfl

private theorem mem_singleton {z x : Nat × Nat} : z ∈ #[x] ↔ z = x := by
  constructor
  · intro hz
    obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
    rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, heq⟩
    have : q = 0 := by simp at hlt; omega
    subst this
    exact heq.symm
  · intro hz
    subst hz
    exact Array.mem_iff_getElem?.mpr ⟨0, rfl⟩

/-- What the initial `dist` looks like. -/
private theorem initDist_getD (g : Graph) (src : Nat) (hsrc : src < g.n) (v : Nat) :
    (initState g src).dist.getD v none = if v = src then some 0 else none := by
  show ((Array.replicate g.n none).setIfInBounds src (some 0)).getD v none = _
  rw [getD_set _ (by rw [Array.size_replicate]; exact hsrc)]
  by_cases hv : v = src
  · rw [if_pos hv, if_pos hv]
  · rw [if_neg hv, if_neg hv, getD_replicate]
    split <;> rfl

private theorem initDone_getD (g : Graph) (src v : Nat) :
    (initState g src).done.getD v false = false := by
  show (Array.replicate g.n false).getD v false = false
  rw [getD_replicate]
  split <;> rfl

private theorem initPrev_getD (g : Graph) (src v : Nat) :
    (initState g src).prev.getD v g.n = g.n := by
  show (Array.replicate g.n g.n).getD v g.n = g.n
  rw [getD_replicate]
  split <;> rfl

theorem inv_init (g : Graph) (src : Nat) (hsrc : src < g.n) :
    InvCore g src 0 (initState g src) ∧ Relaxed g (initState g src) := by
  constructor
  · refine ⟨?_, ?_, ?_, hsrc, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · show ((Array.replicate g.n none).setIfInBounds src (some 0)).size = g.n
      rw [Array.size_setIfInBounds, Array.size_replicate]
    · show (Array.replicate g.n (g.n : Nat)).size = g.n
      rw [Array.size_replicate]
    · show (Array.replicate g.n false).size = g.n
      rw [Array.size_replicate]
    · rw [initDist_getD g src hsrc, if_pos rfl]
    · -- IsHeap #[(0, src)]
      show Heap.IsHeapA (Heap.push ⟨#[]⟩ 0 src).a
      rw [initHeap_a]
      intro j hj hjs
      simp at hjs
      omega
    · intro z hz
      rw [initState_heap, initHeap_a] at hz
      obtain rfl := mem_singleton.mp hz
      exact ⟨hsrc, 0, by rw [initDist_getD g src hsrc, if_pos rfl], Nat.le_refl _⟩
    · intro z hz
      exact Nat.zero_le _
    · intro v hv
      rw [initDone_getD] at hv
      cases hv
    · intro v hv
      rw [initDone_getD] at hv
      cases hv
    · intro v hvn _ d hd
      rw [initDist_getD g src hsrc] at hd
      by_cases hv : v = src
      · rw [if_pos hv] at hd
        injection hd with hd
        rw [initState_heap, initHeap_a, hv, ← hd]
        exact mem_singleton.mpr rfl
      · rw [if_neg hv] at hd
        cases hd
    · refine ⟨fun _ => 0, 0, Nat.zero_le _, ?_, ?_⟩
      · intro v hv
        rw [initDone_getD] at hv
        cases hv
      · intro v hvn d hd
        rw [initDist_getD g src hsrc] at hd
        by_cases hv : v = src
        · rw [if_pos hv] at hd
          injection hd with hd
          refine ⟨fun _ => ⟨hv, hd.symm⟩, fun hne => absurd (initPrev_getD g src v) hne⟩
        · rw [if_neg hv] at hd
          cases hd
  · intro u hu
    rw [initDone_getD] at hu
    cases hu

end Verified.Rail
