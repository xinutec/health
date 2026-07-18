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

/-! ## One relaxation step -/

/-- Case analysis on the TS `nd < (dist[v] ?? Infinity)` test. -/
private theorem improves_spec (st : DState) (v nd : Nat) :
    (improves st v nd = true ∧ ∀ dv, st.dist.getD v none = some dv → nd < dv) ∨
    (improves st v nd = false ∧ ∃ dv, st.dist.getD v none = some dv ∧ dv ≤ nd) := by
  cases hd : st.dist.getD v none with
  | none =>
    left
    refine ⟨?_, fun dv h => nomatch h⟩
    unfold improves
    rw [hd]
  | some dv =>
    by_cases hlt : nd < dv
    · left
      refine ⟨?_, ?_⟩
      · unfold improves
        rw [hd]
        exact decide_eq_true hlt
      · intro dv' h
        injection h with h
        omega
    · right
      refine ⟨?_, dv, rfl, by omega⟩
      unfold improves
      rw [hd]
      exact decide_eq_false hlt

private theorem relaxStep_true {u p : Nat} {st : DState} {tw : Nat × Nat}
    (h : improves st tw.1 (p + tw.2) = true) :
    relaxStep u p st tw = { st with
      dist := st.dist.setIfInBounds tw.1 (some (p + tw.2))
      prev := st.prev.setIfInBounds tw.1 u
      heap := st.heap.push (p + tw.2) tw.1 } := by
  unfold relaxStep
  rw [if_pos h]

private theorem relaxStep_false {u p : Nat} {st : DState} {tw : Nat × Nat}
    (h : improves st tw.1 (p + tw.2) = false) :
    relaxStep u p st tw = st := by
  unfold relaxStep
  rw [if_neg (by rw [h]; exact Bool.false_ne_true)]

/-- The state mid-`relaxAll`: the invariant core at floor `p` (the settle
price of `u`, the vertex being relaxed), everyone else relaxed, and the
`scanned` prefix of `u`'s adjacency relaxed. -/
structure RelaxInv (g : Graph) (src u p : Nat) (scanned : List (Nat × Nat))
    (st : DState) : Prop where
  core : InvCore g src p st
  u_lt : u < g.n
  u_done : st.done.getD u false = true
  u_dist : st.dist.getD u none = some p
  others : RelaxedExcept g u st
  scanned_rel : ∀ tw ∈ scanned,
    ∃ dv, st.dist.getD tw.1 none = some dv ∧ dv ≤ p + tw.2

private theorem relaxStep_inv {g : Graph} {src u p : Nat} {scanned : List (Nat × Nat)}
    {st : DState} (hinv : RelaxInv g src u p scanned st) {tw : Nat × Nat}
    (htw : tw ∈ (g.adj.getD u #[]).toList) (htn : tw.1 < g.n) :
    RelaxInv g src u p (scanned ++ [tw]) (relaxStep u p st tw) := by
  rcases improves_spec st tw.1 (p + tw.2) with ⟨himp, hlt⟩ | ⟨himp, dv0, hdv0, hle0⟩
  · -- The edge improves: dist/prev overwritten, entry pushed.
    rw [relaxStep_true himp]
    -- The target is neither u, nor src, nor settled.
    have hvu : tw.1 ≠ u := by
      intro he
      have := hlt p (by rw [he]; exact hinv.u_dist)
      omega
    have hvund : st.done.getD tw.1 false = false := by
      cases hdone : st.done.getD tw.1 false with
      | false => rfl
      | true =>
        obtain ⟨d, hd, hdle⟩ := hinv.core.done_le tw.1 hdone
        have := hlt d hd
        omega
    have hvsrc : ¬tw.1 = src := by
      intro he
      have := hlt 0 (by rw [he]; exact hinv.core.src_zero)
      omega
    have hds : ∀ x : Nat, (st.dist.setIfInBounds tw.1 (some (p + tw.2))).getD x none =
        if x = tw.1 then some (p + tw.2) else st.dist.getD x none :=
      fun x => getD_set _ (by rw [hinv.core.dist_size]; exact htn) _ x none
    have hps : ∀ x : Nat, (st.prev.setIfInBounds tw.1 u).getD x g.n =
        if x = tw.1 then u else st.prev.getD x g.n :=
      fun x => getD_set _ (by rw [hinv.core.prev_size]; exact htn) _ x g.n
    have hheap : ∀ z : Nat × Nat, z ∈ (st.heap.push (p + tw.2) tw.1).a ↔
        z ∈ st.heap.a ∨ z = (p + tw.2, tw.1) :=
      Heap.push_mem st.heap (p + tw.2) tw.1
    refine ⟨⟨?_, ?_, hinv.core.done_size, hinv.core.src_lt, ?_, ?_, ?_, ?_,
        hinv.core.done_lt, ?_, ?_, ?_⟩, hinv.u_lt, hinv.u_done, ?_, ?_, ?_⟩
    · show (st.dist.setIfInBounds tw.1 (some (p + tw.2))).size = g.n
      rw [Array.size_setIfInBounds]
      exact hinv.core.dist_size
    · show (st.prev.setIfInBounds tw.1 u).size = g.n
      rw [Array.size_setIfInBounds]
      exact hinv.core.prev_size
    · show (st.dist.setIfInBounds tw.1 (some (p + tw.2))).getD src none = some 0
      rw [hds src, if_neg (show ¬src = tw.1 from fun hh => hvsrc hh.symm)]
      exact hinv.core.src_zero
    · exact Heap.push_isHeap st.heap hinv.core.heap_hp _ _
    · -- heap_wf
      intro z hz
      rcases (hheap z).mp hz with hzo | hze
      · obtain ⟨hzn, d, hd, hdz⟩ := hinv.core.heap_wf z hzo
        refine ⟨hzn, ?_⟩
        rw [hds z.2]
        by_cases hzv : z.2 = tw.1
        · rw [if_pos hzv]
          rw [hzv] at hd
          have := hlt d hd
          exact ⟨p + tw.2, rfl, by omega⟩
        · rw [if_neg hzv]
          exact ⟨d, hd, hdz⟩
      · subst hze
        refine ⟨htn, p + tw.2, ?_, Nat.le_refl _⟩
        rw [hds tw.1, if_pos rfl]
    · -- heap_ge
      intro z hz
      rcases (hheap z).mp hz with hzo | hze
      · exact hinv.core.heap_ge z hzo
      · subst hze
        exact Nat.le_add_right _ _
    · -- done_le
      intro v hv
      obtain ⟨d, hd, hdle⟩ := hinv.core.done_le v hv
      refine ⟨d, ?_, hdle⟩
      rw [hds v, if_neg (fun he => by rw [he] at hv; rw [hv] at hvund; cases hvund)]
      exact hd
    · -- undone_heap
      intro v hvn hvd d hd
      rw [hds v] at hd
      rw [hheap]
      by_cases hvv : v = tw.1
      · rw [if_pos hvv] at hd
        injection hd with hd
        right
        rw [hvv, ← hd]
      · rw [if_neg hvv] at hd
        exact .inl (hinv.core.undone_heap v hvn hvd d hd)
    · -- tree ghost
      obtain ⟨pos, c, hc, gpos, gtree⟩ := hinv.core.tree
      refine ⟨fun x => if x = tw.1 then c else pos x, c, hc, ?_, ?_⟩
      · intro v hv
        dsimp only
        rw [if_neg (show ¬v = tw.1 from fun he => by rw [he] at hv; rw [hv] at hvund; cases hvund)]
        exact gpos v hv
      · intro v hvn d hd
        rw [hds v] at hd
        by_cases hvv : v = tw.1
        · rw [if_pos hvv] at hd
          injection hd with hd
          constructor
          · intro hsent
            rw [hps v, if_pos hvv] at hsent
            exact absurd hsent (by have := hinv.u_lt; omega)
          · intro _
            rw [hps v, if_pos hvv]
            refine ⟨hinv.u_lt, hinv.u_done, ?_, tw.2, p, ?_, ?_, by omega⟩
            · dsimp only
              rw [if_neg (show ¬u = tw.1 from fun he => hvu he.symm), if_pos hvv]
              exact gpos u hinv.u_done
            · rw [hvv]
              exact htw
            · rw [hds u, if_neg (show ¬u = tw.1 from fun he => hvu he.symm)]
              exact hinv.u_dist
        · rw [if_neg hvv] at hd
          obtain ⟨hsent, hstep⟩ := gtree v hvn d hd
          rw [hps v, if_neg hvv]
          refine ⟨hsent, ?_⟩
          intro hne
          obtain ⟨hun, hud, hpp, w, du, hmem, hdu, hsum⟩ := hstep hne
          have hpu : ¬st.prev.getD v g.n = tw.1 := by
            intro he
            rw [he] at hud
            rw [hud] at hvund
            cases hvund
          refine ⟨hun, hud, ?_, w, du, hmem, ?_, hsum⟩
          · dsimp only
            rw [if_neg hpu, if_neg hvv]
            exact hpp
          · rw [hds _, if_neg hpu]
            exact hdu
    · -- u untouched
      show (st.dist.setIfInBounds tw.1 (some (p + tw.2))).getD u none = some p
      rw [hds u, if_neg (fun he => hvu he.symm)]
      exact hinv.u_dist
    · -- others stay relaxed: the improved dist only shrinks.
      intro u' hu' huu du' hdu' tw' htw'
      have hu'v : u' ≠ tw.1 := by
        intro he
        rw [he] at hu'
        rw [hu'] at hvund
        cases hvund
      rw [hds u', if_neg hu'v] at hdu'
      obtain ⟨dv, hdv, hdvle⟩ := hinv.others u' hu' huu du' hdu' tw' htw'
      rw [hds tw'.1]
      by_cases htv : tw'.1 = tw.1
      · rw [if_pos htv]
        rw [htv] at hdv
        have := hlt dv hdv
        exact ⟨p + tw.2, rfl, by omega⟩
      · rw [if_neg htv]
        exact ⟨dv, hdv, hdvle⟩
    · -- scanned + the new edge
      intro tw' htw'
      rcases List.mem_append.mp htw' with hold | hnew
      · obtain ⟨dv, hdv, hdvle⟩ := hinv.scanned_rel tw' hold
        rw [hds tw'.1]
        by_cases htv : tw'.1 = tw.1
        · rw [if_pos htv]
          rw [htv] at hdv
          have := hlt dv hdv
          exact ⟨p + tw.2, rfl, by omega⟩
        · rw [if_neg htv]
          exact ⟨dv, hdv, hdvle⟩
      · obtain rfl : tw' = tw := by simpa using hnew
        rw [hds tw'.1, if_pos rfl]
        exact ⟨p + tw'.2, rfl, Nat.le_refl _⟩
  · -- No improvement: state unchanged, the edge was already relaxed.
    rw [relaxStep_false himp]
    refine ⟨hinv.core, hinv.u_lt, hinv.u_done, hinv.u_dist, hinv.others, ?_⟩
    intro tw' htw'
    rcases List.mem_append.mp htw' with hold | hnew
    · exact hinv.scanned_rel tw' hold
    · obtain rfl : tw' = tw := by simpa using hnew
      exact ⟨dv0, hdv0, hle0⟩

private theorem relaxList_inv {g : Graph} {src u p : Nat} :
    ∀ (rest scanned : List (Nat × Nat)) (st : DState),
      RelaxInv g src u p scanned st →
      (∀ tw ∈ rest, tw ∈ (g.adj.getD u #[]).toList ∧ tw.1 < g.n) →
      RelaxInv g src u p (scanned ++ rest) (rest.foldl (relaxStep u p) st)
  | [], scanned, st, hinv, _ => by simpa using hinv
  | tw :: rest, scanned, st, hinv, hrest => by
    rw [List.foldl_cons]
    have hres := relaxList_inv rest (scanned ++ [tw]) (relaxStep u p st tw)
      (relaxStep_inv hinv (hrest tw (.head _)).1 (hrest tw (.head _)).2)
      (fun tw' h => hrest tw' (.tail _ h))
    simpa [List.append_assoc] using hres

/-- After `relaxAll`, the full invariant (floor = the settle price) plus
full relaxedness hold. -/
theorem relaxAll_inv {g : Graph} {src u p : Nat} {st : DState} (hwf : WFEdges g)
    (hinv : RelaxInv g src u p [] st) :
    InvCore g src p (relaxAll u p (g.adj.getD u #[]) st) ∧
      Relaxed g (relaxAll u p (g.adj.getD u #[]) st) := by
  have hfold : relaxAll u p (g.adj.getD u #[]) st =
      (g.adj.getD u #[]).toList.foldl (relaxStep u p) st := by
    unfold relaxAll
    rw [← Array.foldl_toList]
  have hres := relaxList_inv (g := g) (src := src) ((g.adj.getD u #[]).toList) [] st hinv
    (fun tw h => ⟨h, hwf u hinv.u_lt tw h⟩)
  rw [← hfold] at hres
  refine ⟨hres.core, ?_⟩
  intro u' hu'
  by_cases huu : u' = u
  · subst huu
    intro du hdu tw htw
    have hsc := hres.scanned_rel tw htw
    rw [hres.u_dist] at hdu
    injection hdu with hdu
    rw [← hdu]
    exact hsc
  · exact hres.others u' hu' huu

end Verified.Rail
