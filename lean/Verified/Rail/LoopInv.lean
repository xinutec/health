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

/-! ## The two pop steps -/

/-- Flipping one absent element into a filter grows it by exactly one. -/
private theorem length_filter_flip :
    ∀ (l : List Nat) (f f' : Nat → Bool) (u : Nat), l.Nodup → u ∈ l →
      f u = false → f' u = true → (∀ x, x ≠ u → f' x = f x) →
      (l.filter f').length = (l.filter f).length + 1
  | [], _, _, _, _, hmem, _, _, _ => nomatch hmem
  | a :: t, f, f', u, hnd, hmem, hfu, hfu', hcong => by
    rcases List.mem_cons.mp hmem with rfl | hmt
    · have hnotin : ∀ x ∈ t, x ≠ u := by
        intro x hx he
        subst he
        exact (List.nodup_cons.mp hnd).1 hx
      rw [List.filter_cons, List.filter_cons, if_pos hfu',
        if_neg (by rw [hfu]; exact Bool.false_ne_true),
        List.filter_congr (fun x hx => hcong x (hnotin x hx)), List.length_cons]
    · have hau : a ≠ u := by
        intro he
        subst he
        exact (List.nodup_cons.mp hnd).1 hmt
      have ih := length_filter_flip t f f' u (List.nodup_cons.mp hnd).2 hmt hfu hfu' hcong
      rw [List.filter_cons, List.filter_cons, hcong a hau]
      by_cases hfa : f a = true
      · rw [if_pos hfa, if_pos hfa, List.length_cons, List.length_cons, ih]
      · rw [if_neg hfa, if_neg hfa]
        exact ih

/-- Popping an already-settled entry (lazy deletion) keeps everything. -/
theorem skip_inv {g : Graph} {src L p u : Nat} {st : DState} {h' : Heap}
    (hcore : InvCore g src L st) (hpop : st.heap.pop = some ((p, u), h'))
    (hdone : st.done.getD u false = true) :
    InvCore g src L { st with heap := h' } := by
  refine ⟨hcore.dist_size, hcore.prev_size, hcore.done_size, hcore.src_lt, hcore.src_zero,
    Heap.pop_isHeap hcore.heap_hp hpop, ?_, ?_, hcore.done_lt, hcore.done_le, ?_,
    hcore.tree⟩
  · intro z hz
    exact hcore.heap_wf z (Heap.pop_mem hpop z hz)
  · intro z hz
    exact hcore.heap_ge z (Heap.pop_mem hpop z hz)
  · intro v hvn hvd d hd
    rcases Heap.pop_cover hpop (d, v) (hcore.undone_heap v hvn hvd d hd) with he | hm
    · injection he with h1 h2
      rw [h2] at hvd
      rw [hvd] at hdone
      cases hdone
    · exact hm

/-- Popping a fresh vertex: it was priced exactly at the popped priority,
the floor advances to it, and the settled state is ready for `relaxAll`. -/
theorem settle_inv {g : Graph} {src L p u : Nat} {st : DState} {h' : Heap}
    (hcore : InvCore g src L st) (hrel : Relaxed g st)
    (hpop : st.heap.pop = some ((p, u), h'))
    (hund : st.done.getD u false = false) :
    L ≤ p ∧ u < g.n ∧ st.dist.getD u none = some p ∧
      RelaxInv g src u p []
        { st with heap := h', done := st.done.setIfInBounds u true } := by
  have hmem : (p, u) ∈ st.heap.a := Heap.pop_top_mem hpop
  obtain ⟨hun, d0, hd0, hd0le⟩ := hcore.heap_wf (p, u) hmem
  have hLp : L ≤ p := hcore.heap_ge (p, u) hmem
  have hd0ge : p ≤ d0 :=
    Heap.pop_min hcore.heap_hp hpop (d0, u) (hcore.undone_heap u hun hund d0 hd0)
  have hdu : st.dist.getD u none = some p := by
    rw [hd0]
    congr 1
    omega
  have hdset : ∀ x : Nat, (st.done.setIfInBounds u true).getD x false =
      if x = u then true else st.done.getD x false :=
    fun x => getD_set _ (by rw [hcore.done_size]; exact hun) _ x false
  refine ⟨hLp, hun, hdu, ⟨?_, ?_, ?_, hcore.src_lt, hcore.src_zero,
      Heap.pop_isHeap hcore.heap_hp hpop, ?_, ?_, ?_, ?_, ?_, ?_⟩,
    hun, ?_, hdu, ?_, fun tw h => nomatch h⟩
  · exact hcore.dist_size
  · exact hcore.prev_size
  · show (st.done.setIfInBounds u true).size = g.n
    rw [Array.size_setIfInBounds]
    exact hcore.done_size
  · intro z hz
    exact hcore.heap_wf z (Heap.pop_mem hpop z hz)
  · intro z hz
    exact Heap.pop_min hcore.heap_hp hpop z (Heap.pop_mem hpop z hz)
  · -- done_lt
    intro v hv
    rw [hdset v] at hv
    by_cases hvu : v = u
    · rw [hvu]
      exact hun
    · rw [if_neg hvu] at hv
      exact hcore.done_lt v hv
  · -- done_le at the new floor p
    intro v hv
    rw [hdset v] at hv
    by_cases hvu : v = u
    · rw [hvu]
      exact ⟨p, hdu, Nat.le_refl _⟩
    · rw [if_neg hvu] at hv
      obtain ⟨d, hd, hdle⟩ := hcore.done_le v hv
      exact ⟨d, hd, by omega⟩
  · -- undone_heap
    intro v hvn hvd d hd
    rw [hdset v] at hvd
    by_cases hvu : v = u
    · rw [if_pos hvu] at hvd
      cases hvd
    · rw [if_neg hvu] at hvd
      rcases Heap.pop_cover hpop (d, v) (hcore.undone_heap v hvn hvd d hd) with he | hm
      · injection he with h1 h2
        exact absurd h2 hvu
      · exact hm
  · -- tree ghost: rank u at c, bump the counter
    obtain ⟨pos, c, hc, gpos, gtree⟩ := hcore.tree
    refine ⟨fun x => if x = u then c else pos x, c + 1, ?_, ?_, ?_⟩
    · -- counter stays below the settled count
      have : doneCount g { st with heap := h', done := st.done.setIfInBounds u true } =
          doneCount g st + 1 := by
        unfold doneCount
        refine length_filter_flip (List.range g.n) _ _ u List.nodup_range
          (List.mem_range.mpr hun) hund ?_ ?_
        · show (st.done.setIfInBounds u true).getD u false = true
          rw [hdset u, if_pos rfl]
        · intro x hx
          show (st.done.setIfInBounds u true).getD x false = st.done.getD x false
          rw [hdset x, if_neg hx]
      omega
    · intro v hv
      rw [hdset v] at hv
      dsimp only
      by_cases hvu : v = u
      · rw [if_pos hvu]
        omega
      · rw [if_neg hvu] at hv
        rw [if_neg hvu]
        exact Nat.lt_succ_of_lt (gpos v hv)
    · intro v hvn d hd
      obtain ⟨hsent, hstep⟩ := gtree v hvn d hd
      refine ⟨hsent, ?_⟩
      intro hne
      obtain ⟨hpn, hpd, hpp, w, du, hmem', hdu', hsum⟩ := hstep hne
      have hpvu : ¬st.prev.getD v g.n = u := by
        intro he
        rw [he] at hpd
        rw [hpd] at hund
        cases hund
      refine ⟨hpn, ?_, ?_, w, du, hmem', hdu', hsum⟩
      · rw [hdset _, if_neg hpvu]
        exact hpd
      · dsimp only
        rw [if_neg hpvu]
        by_cases hvu : v = u
        · rw [if_pos hvu]
          exact Nat.lt_of_lt_of_le (gpos _ hpd) (by omega)
        · rw [if_neg hvu]
          exact hpp
  · -- u is settled…
    show (st.done.setIfInBounds u true).getD u false = true
    rw [hdset u, if_pos rfl]
  · -- …and everyone previously settled is still relaxed
    intro u' hu' huu
    have hu'o : st.done.getD u' false = true := by
      rw [hdset u', if_neg huu] at hu'
      exact hu'
    exact hrel u' hu'o

/-! ## Fuel accounting -/

private theorem relaxAll_eq_foldl (u p : Nat) (edges : Array (Nat × Nat)) (st : DState) :
    relaxAll u p edges st = edges.toList.foldl (relaxStep u p) st := by
  unfold relaxAll
  rw [← Array.foldl_toList]

private theorem relaxStep_done (u p : Nat) (st : DState) (tw : Nat × Nat) :
    (relaxStep u p st tw).done = st.done := by
  rcases improves_spec st tw.1 (p + tw.2) with ⟨h, _⟩ | ⟨h, _⟩
  · rw [relaxStep_true h]
  · rw [relaxStep_false h]

private theorem relaxList_done (u p : Nat) :
    ∀ (l : List (Nat × Nat)) (st : DState), (l.foldl (relaxStep u p) st).done = st.done
  | [], _ => rfl
  | tw :: l, st => by
    rw [List.foldl_cons, relaxList_done u p l, relaxStep_done]

private theorem relaxAll_done (u p : Nat) (edges : Array (Nat × Nat)) (st : DState) :
    (relaxAll u p edges st).done = st.done := by
  rw [relaxAll_eq_foldl]
  exact relaxList_done u p _ _

private theorem relaxStep_heap_le (u p : Nat) (st : DState) (tw : Nat × Nat) :
    (relaxStep u p st tw).heap.a.size ≤ st.heap.a.size + 1 := by
  rcases improves_spec st tw.1 (p + tw.2) with ⟨h, _⟩ | ⟨h, _⟩
  · rw [relaxStep_true h]
    exact Nat.le_of_eq (Heap.push_size st.heap (p + tw.2) tw.1)
  · rw [relaxStep_false h]
    exact Nat.le_add_right _ _

private theorem relaxList_heap_le (u p : Nat) :
    ∀ (l : List (Nat × Nat)) (st : DState),
      (l.foldl (relaxStep u p) st).heap.a.size ≤ st.heap.a.size + l.length
  | [], st => Nat.le_add_right _ _
  | tw :: l, st => by
    rw [List.foldl_cons]
    have h1 := relaxList_heap_le u p l (relaxStep u p st tw)
    have h2 := relaxStep_heap_le u p st tw
    rw [List.length_cons]
    omega

/-- Flipping one absent element out of a sum removes exactly its term. -/
theorem sum_map_flip :
    ∀ (l : List Nat) (f f' : Nat → Nat) (u : Nat), l.Nodup → u ∈ l →
      (∀ x, x ≠ u → f' x = f x) → f' u = 0 →
      (l.map f').sum + f u = (l.map f).sum
  | [], _, _, _, _, hmem, _, _ => nomatch hmem
  | a :: t, f, f', u, hnd, hmem, hcong, hu0 => by
    rcases List.mem_cons.mp hmem with rfl | hmt
    · have hnotin : ∀ x ∈ t, x ≠ u := fun x hx he =>
        (List.nodup_cons.mp hnd).1 (he ▸ hx)
      rw [List.map_cons, List.map_cons, List.sum_cons, List.sum_cons, hu0,
        List.map_congr_left (fun x hx => hcong x (hnotin x hx))]
      omega
    · have hau : a ≠ u := fun he => (List.nodup_cons.mp hnd).1 (he ▸ hmt)
      have ih := sum_map_flip t f f' u (List.nodup_cons.mp hnd).2 hmt hcong hu0
      rw [List.map_cons, List.map_cons, List.sum_cons, List.sum_cons, hcong a hau]
      omega

/-- Adjacency size still chargeable to future settles. -/
def undoneOut (g : Graph) (st : DState) : Nat :=
  ((List.range g.n).map
    (fun u => if st.done.getD u false then 0 else (g.adj.getD u #[]).size)).sum

/-- Strictly decreases at every pop — the TS fuel `E + n + 2` never runs
out before the heap does. -/
def potential (g : Graph) (st : DState) : Nat :=
  st.heap.a.size + undoneOut g st

private theorem pop_pos {st : DState} {t : Nat × Nat} {h' : Heap}
    (hpop : st.heap.pop = some (t, h')) : 0 < st.heap.a.size := by
  rcases Nat.eq_zero_or_pos st.heap.a.size with hz | hp0
  · rw [Heap.pop_none_iff.mpr hz] at hpop
    cases hpop
  · exact hp0

private theorem potential_skip {g : Graph} {st : DState} {t : Nat × Nat} {h' : Heap}
    (hpop : st.heap.pop = some (t, h')) :
    potential g { st with heap := h' } + 1 ≤ potential g st := by
  have h0 := pop_pos hpop
  have hsz := Heap.pop_size hpop
  have hout : undoneOut g { st with heap := h' } = undoneOut g st := rfl
  have hh : ({ st with heap := h' } : DState).heap = h' := rfl
  unfold potential
  rw [hh, hout]
  omega

private theorem potential_settle {g : Graph} {st : DState} {p u : Nat} {h' : Heap}
    (hpop : st.heap.pop = some ((p, u), h')) (hun : u < g.n)
    (hund : st.done.getD u false = false) (hn : st.done.size = g.n) :
    potential g (relaxAll u p (g.adj.getD u #[])
        { st with heap := h', done := st.done.setIfInBounds u true }) + 1 ≤
      potential g st := by
  have h0 := pop_pos hpop
  have hsz := Heap.pop_size hpop
  have hheap : (relaxAll u p (g.adj.getD u #[])
      { st with heap := h', done := st.done.setIfInBounds u true }).heap.a.size ≤
      h'.a.size + (g.adj.getD u #[]).size := by
    rw [relaxAll_eq_foldl]
    have hle := relaxList_heap_le u p (g.adj.getD u #[]).toList
      { st with heap := h', done := st.done.setIfInBounds u true }
    have hh : ({ st with heap := h', done := st.done.setIfInBounds u true } : DState).heap
        = h' := rfl
    rw [hh, Array.length_toList] at hle
    exact hle
  have hd1 : (relaxAll u p (g.adj.getD u #[])
      { st with heap := h', done := st.done.setIfInBounds u true }).done =
      st.done.setIfInBounds u true := by
    rw [relaxAll_eq_foldl]
    exact relaxList_done u p _ _
  have hflip := sum_map_flip (List.range g.n)
    (fun x => if st.done.getD x false then 0 else (g.adj.getD x #[]).size)
    (fun x => if (st.done.setIfInBounds u true).getD x false then 0
      else (g.adj.getD x #[]).size)
    u List.nodup_range (List.mem_range.mpr hun)
    (fun x hx => by
      dsimp only
      rw [getD_set _ (by rw [hn]; exact hun), if_neg hx])
    (by
      dsimp only
      rw [getD_set _ (by rw [hn]; exact hun), if_pos rfl, if_pos rfl])
  dsimp only at hflip
  rw [if_neg (show ¬st.done.getD u false = true by rw [hund]; exact Bool.false_ne_true)]
    at hflip
  have hout1 : undoneOut g (relaxAll u p (g.adj.getD u #[])
      { st with heap := h', done := st.done.setIfInBounds u true }) =
      ((List.range g.n).map (fun x => if (st.done.setIfInBounds u true).getD x false then 0
        else (g.adj.getD x #[]).size)).sum := by
    unfold undoneOut
    rw [hd1]
  have hout0 : undoneOut g st =
      ((List.range g.n).map (fun x => if st.done.getD x false then 0
        else (g.adj.getD x #[]).size)).sum := rfl
  unfold potential
  rw [hout1, hout0]
  omega

/-! ## The loop -/

/-- The master induction: with the invariant and enough fuel, the loop
lands in one of the two legitimate exits — heap exhausted with everything
relaxed, or `dst` settled at the final floor price with everything but
`dst` relaxed. Settled vertices stay settled. -/
theorem loop_spec (g : Graph) (src dst : Nat) (hwf : WFEdges g) :
    ∀ (fuel : Nat) (st : DState) (L : Nat),
      InvCore g src L st → Relaxed g st → potential g st < fuel →
      ∃ L', L ≤ L' ∧
        InvCore g src L' (loop g dst fuel st) ∧
        (∀ v, st.done.getD v false = true →
          (loop g dst fuel st).done.getD v false = true) ∧
        (((loop g dst fuel st).heap.pop = none ∧ Relaxed g (loop g dst fuel st)) ∨
          ((loop g dst fuel st).done.getD dst false = true ∧
            (loop g dst fuel st).dist.getD dst none = some L' ∧
            RelaxedExcept g dst (loop g dst fuel st)))
  | 0, st, L => fun _ _ hfuel => absurd hfuel (Nat.not_lt_zero _)
  | fuel + 1, st, L => fun hcore hrel hfuel => by
    simp only [loop]
    split
    · -- Heap exhausted.
      next hpop =>
      exact ⟨L, Nat.le_refl _, hcore, fun v hv => hv, .inl ⟨hpop, hrel⟩⟩
    · next p u h' hpop =>
      by_cases hdone : st.done.getD u false = true
      · -- Lazy deletion: skip a stale entry.
        rw [if_pos hdone]
        have hnext := potential_skip (g := g) hpop
        obtain ⟨L', hLL', hinv', hmono', hexit'⟩ :=
          loop_spec g src dst hwf fuel { st with heap := h' } L
            (skip_inv hcore hpop hdone) hrel (by omega)
        exact ⟨L', hLL', hinv', fun v hv => hmono' v hv, hexit'⟩
      · have hund : st.done.getD u false = false := by
          cases hb : st.done.getD u false with
          | false => rfl
          | true => exact absurd hb hdone
        rw [if_neg hdone]
        obtain ⟨hLp, hun, hdu, hrinv⟩ := settle_inv hcore hrel hpop hund
        have hmono2 : ∀ v, st.done.getD v false = true →
            (st.done.setIfInBounds u true).getD v false = true := by
          intro v hv
          rw [getD_set _ (by rw [hcore.done_size]; exact hun)]
          by_cases hvu : v = u
          · rw [if_pos hvu]
          · rw [if_neg hvu]
            exact hv
        by_cases hud : u = dst
        · -- Early exit: dst settled at price p.
          rw [if_pos hud]
          refine ⟨p, hLp, hrinv.core, hmono2, .inr ⟨?_, ?_, ?_⟩⟩
          · show (st.done.setIfInBounds u true).getD dst false = true
            rw [← hud, getD_set _ (by rw [hcore.done_size]; exact hun), if_pos rfl]
          · rw [← hud]
            exact hdu
          · intro u' hu' hu'd
            have hu'o : st.done.getD u' false = true := by
              rw [getD_set _ (by rw [hcore.done_size]; exact hun)] at hu'
              rw [if_neg (show ¬u' = u from fun he => hu'd (he.trans hud))] at hu'
              exact hu'
            exact hrel u' hu'o
        · -- Settle u, relax its edges, continue.
          rw [if_neg hud]
          obtain ⟨hinv2, hrel2⟩ := relaxAll_inv hwf hrinv
          have hnext := potential_settle hpop hun hund hcore.done_size
          obtain ⟨L', hpL', hinv', hmono', hexit'⟩ :=
            loop_spec g src dst hwf fuel
              (relaxAll u p (g.adj.getD u #[])
                { st with heap := h', done := st.done.setIfInBounds u true })
              p hinv2 hrel2 (by omega)
          refine ⟨L', by omega, hinv', ?_, hexit'⟩
          intro v hv
          refine hmono' v ?_
          rw [relaxAll_done]
          exact hmono2 v hv

/-! ## Rebuilding the path

The ghost ranks make the `prev` walk terminate without repeating: every
hop strictly descends `pos`, every visited vertex is settled, and each
hop's recorded edge telescopes the cost. The walk's cost lands `≤ D`; the
exact `= D` comes later from `cut_bound` — the certificate corrects any
cheaper parallel edge the recorded hop missed. -/

private theorem pathCost_singleton (g : Graph) (v : Nat) : pathCost g [v] = some 0 := rfl

private theorem rebuild_walk {g : Graph} {src : Nat} {st : DState}
    {pos : Nat → Nat} {c : Nat} {dstv D : Nat}
    (hgtree : TreeGhost g src st pos c)
    (hD : st.dist.getD dstv none = some D) :
    ∀ (fuel v d : Nat) (acc : List Nat) (C : Nat),
      v < g.n → st.done.getD v false = true → st.dist.getD v none = some d →
      pos v + 1 ≤ fuel →
      (v :: acc).getLast? = some dstv →
      nodupB (v :: acc) = true →
      (∀ x ∈ acc, x < g.n ∧ st.done.getD x false = true ∧ pos v < pos x) →
      pathCost g (v :: acc) = some C → C + d ≤ D →
      acc.length + pos v + 1 ≤ c →
      ∃ p C', rebuild st.prev g.n fuel v acc = some p ∧
        p.head? = some src ∧ p.getLast? = some dstv ∧
        pathCost g p = some C' ∧ C' ≤ D ∧ nodupB p = true ∧ p.length ≤ c
  | 0, v, d, acc, C => fun _ _ _ hfuel _ _ _ _ _ _ => by omega
  | fuel + 1, v, d, acc, C => fun hvn hvdone hvd hfuel hlast hnd hacc hcost hCd hlen => by
    simp only [rebuild]
    obtain ⟨hsent, hstep⟩ := hgtree.2 v hvn d hvd
    by_cases hpv : st.prev.getD v g.n = g.n
    · -- Sentinel: this is the source, cost telescope complete.
      rw [if_pos hpv]
      obtain ⟨hvsrc, hd0⟩ := hsent hpv
      refine ⟨v :: acc, C, rfl, ?_, hlast, hcost, by omega, hnd, ?_⟩
      · rw [hvsrc]
        rfl
      · rw [List.length_cons]
        omega
    · rw [if_neg hpv]
      obtain ⟨hun, hud, hpp, w, du, hmem, hdu, hsum⟩ := hstep hpv
      obtain ⟨wm, hwm, hwmle⟩ := edgeMinW_le_of_mem hmem
      have hcost' : pathCost g (st.prev.getD v g.n :: v :: acc) = some (wm + C) := by
        simp only [pathCost_cons_cons, hwm, hcost]
      have hnotmem : ∀ x ∈ v :: acc, st.prev.getD v g.n ≠ x := by
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hxa
        · exact fun he => absurd (he ▸ hpp) (Nat.lt_irrefl _)
        · obtain ⟨_, _, hvx⟩ := hacc x hxa
          intro he
          have hpp' := he ▸ hpp
          omega
      have hnd' : nodupB (st.prev.getD v g.n :: v :: acc) = true := by
        rw [nodupB_cons, Bool.and_eq_true]
        refine ⟨?_, hnd⟩
        rw [Bool.not_eq_true']
        cases hb : (v :: acc).contains (st.prev.getD v g.n) with
        | false => rfl
        | true =>
          have hm := List.contains_iff_mem.mp hb
          exact absurd rfl (hnotmem _ hm)
      have hacc' : ∀ x ∈ v :: acc, x < g.n ∧ st.done.getD x false = true ∧
          pos (st.prev.getD v g.n) < pos x := by
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hxa
        · exact ⟨hvn, hvdone, hpp⟩
        · obtain ⟨h1, h2, h3⟩ := hacc x hxa
          exact ⟨h1, h2, by omega⟩
      have hlast' : (st.prev.getD v g.n :: v :: acc).getLast? = some dstv := by
        rw [List.getLast?_cons_cons]
        exact hlast
      exact rebuild_walk hgtree hD fuel (st.prev.getD v g.n) du (v :: acc) (wm + C)
        hun hud hdu (by omega) hlast' hnd' hacc' hcost' (by omega)
        (by rw [List.length_cons]; omega)

/-- Walking `prev` from any settled vertex succeeds within the `n + 1`
fuel, producing a nodup `src → dstv` path costing at most the settled
distance. -/
theorem rebuild_spec {g : Graph} {src L dstv D : Nat} {st : DState}
    (hcore : InvCore g src L st) (hdone : st.done.getD dstv false = true)
    (hD : st.dist.getD dstv none = some D) :
    ∃ p C, rebuild st.prev g.n (g.n + 1) dstv [] = some p ∧
      p.head? = some src ∧ p.getLast? = some dstv ∧
      pathCost g p = some C ∧ C ≤ D ∧ nodupB p = true ∧ p.length ≤ g.n := by
  obtain ⟨pos, c, hc, gpos, gtree⟩ := hcore.tree
  have hdn := hcore.done_lt dstv hdone
  have hcn : c ≤ g.n := by
    have h1 : doneCount g st ≤ g.n := by
      unfold doneCount
      have h2 := List.length_filter_le (fun v => st.done.getD v false) (List.range g.n)
      rw [List.length_range] at h2
      exact h2
    omega
  obtain ⟨p, C', hreb, hhead, hlast, hcost, hCle, hnd, hplen⟩ :=
    rebuild_walk ⟨gpos, gtree⟩ hD (g.n + 1) dstv D [] 0
      hdn hdone hD
      (by have := gpos dstv hdone; omega)
      rfl rfl
      (fun x hx => nomatch hx)
      (pathCost_singleton g dstv)
      (by omega)
      (by have := gpos dstv hdone; simp only [List.length_nil]; omega)
  exact ⟨p, C', hreb, hhead, hlast, hcost, hCle, hnd, by omega⟩

/-! ## The certificate passes on a legitimate exit -/

/-- The final `done`/`dist` arrays form a feasible cut. At the `dst` early
exit, `dst`'s own edges are covered not by relaxation but by every settled
price being `≤ D` (the floor); everywhere else the relaxation clause and
the no-cheap-unsettled fact close the two branches. -/
private theorem feasibleCut_exit {g : Graph} {src L D dst : Nat} {st : DState}
    (hwf : WFEdges g) (hcore : InvCore g src L st)
    (hexc : RelaxedExcept g dst st)
    (hdd : st.dist.getD dst none = some D)
    (hcase : D = L ∨ RelaxedAt g st dst)
    (hnocheap : ∀ v, v < g.n → st.done.getD v false = false →
      ∀ d', st.dist.getD v none = some d' → D ≤ d') :
    feasibleCut g st.done st.dist D = true := by
  unfold feasibleCut
  rw [List.all_eq_true]
  intro u hu
  have hun := List.mem_range.mp hu
  cases hd : st.done.getD u false with
  | false => rfl
  | true =>
    obtain ⟨du, hdu, hdule⟩ := hcore.done_le u hd
    rw [hdu]
    simp only [Bool.not_true, Bool.false_or]
    rw [List.all_eq_true]
    intro tw htw
    rw [Bool.and_eq_true]
    have htn := hwf u hun tw htw
    refine ⟨decide_eq_true htn, ?_⟩
    -- Either u's edges are relaxed, or u is dst priced at the floor.
    have hedge : (∃ dv, st.dist.getD tw.1 none = some dv ∧ dv ≤ du + tw.2) ∨
        (du = D ∧ D = L) := by
      by_cases hud : u = dst
      · rcases hcase with hDL | hrat
        · right
          rw [hud] at hdu
          exact ⟨Option.some.inj (hdu.symm.trans hdd), hDL⟩
        · left
          rw [hud] at hdu htw
          exact hrat du hdu tw htw
      · left
        exact hexc u hd hud du hdu tw htw
    by_cases hdv : st.done.getD tw.1 false = true
    · rw [if_pos hdv]
      rcases hedge with ⟨dv, hdvd, hdvle⟩ | ⟨hduD, hDL⟩
      · rw [hdvd]
        exact decide_eq_true hdvle
      · obtain ⟨dv, hdvd, hdvle⟩ := hcore.done_le tw.1 hdv
        rw [hdvd]
        exact decide_eq_true (by omega)
    · rw [if_neg hdv]
      have hdvf : st.done.getD tw.1 false = false := by
        cases hb : st.done.getD tw.1 false with
        | false => rfl
        | true => exact absurd hb hdv
      rcases hedge with ⟨dv, hdvd, hdvle⟩ | ⟨hduD, hDL⟩
      · have := hnocheap tw.1 htn hdvf dv hdvd
        exact decide_eq_true (by omega)
      · exact decide_eq_true (by omega)

/-- On any exit state that keeps the invariant, the rebuilt path passes
the full certificate — `cut_bound` closes the gap between the walk's
`≤ D` cost and the exact `= D` the checker demands. -/
theorem exit_certify {g : Graph} {src dst L D : Nat} {st : DState} (hwf : WFEdges g)
    (hcore : InvCore g src L st)
    (hsrcdone : st.done.getD src false = true)
    (hdstdone : st.done.getD dst false = true)
    (hdd : st.dist.getD dst none = some D)
    (hexc : RelaxedExcept g dst st)
    (hcase : D = L ∨ RelaxedAt g st dst)
    (hnocheap : ∀ v, v < g.n → st.done.getD v false = false →
      ∀ d', st.dist.getD v none = some d' → D ≤ d') :
    ∃ p, rebuild st.prev g.n (g.n + 1) dst [] = some p ∧
      certify g src dst st.done st.dist D p = true := by
  obtain ⟨p, C, hreb, hhead, hlast, hcost, hCle, hnd, hplen⟩ := rebuild_spec hcore hdstdone hdd
  have hfeas := feasibleCut_exit hwf hcore hexc hdd hcase hnocheap
  have hlow := cut_bound hfeas hdd p src 0 C hhead hlast hcost hsrcdone hcore.src_lt
    hcore.src_zero
  have hCD : C = D := by omega
  refine ⟨p, hreb, ?_⟩
  have hvalid : isValidPath g src dst p = true := by
    cases p with
    | nil => cases hhead
    | cons a rest =>
      have ha : a = src := by simpa using hhead
      simp only [isValidPath, Bool.and_eq_true]
      refine ⟨⟨?_, ?_⟩, ?_⟩
      · rw [ha]
        exact beq_self_eq_true src
      · rw [List.getLast!_of_getLast? hlast]
        exact beq_self_eq_true dst
      · rw [hcost]
        rfl
  simp only [certify, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq]
  refine ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨hvalid, hhead⟩, hlast⟩, ?_⟩, hnd⟩, by omega⟩, hcore.src_lt⟩,
    hcore.src_zero⟩, hdd⟩, hsrcdone⟩, hfeas⟩
  rw [hcost, hCD]

/-! ## The full run

`dijkstraSt` seeds the heap with exactly `(0, src)`, so the first
iteration settles the source; from there `loop_spec` carries the
invariant to an exit. The TS fuel covers the whole run because the
potential starts at `1 + Σ out-degrees ≤ E + 1 < E + n + 2`. -/

theorem foldl_add_sum : ∀ (l : List (Array (Nat × Nat))) (acc : Nat),
    l.foldl (fun a r => a + r.size) acc = acc + (l.map Array.size).sum
  | [], acc => by
    rw [List.foldl_nil, List.map_nil, List.sum_nil]
    omega
  | r :: l, acc => by
    rw [List.foldl_cons, List.map_cons, List.sum_cons, foldl_add_sum l (acc + r.size)]
    omega

theorem map_range_getD : ∀ (l : List (Array (Nat × Nat))),
    (List.range l.length).map (fun u => (l.getD u #[]).size) = l.map Array.size
  | [] => rfl
  | a :: t => by
    rw [List.length_cons, List.range_succ_eq_map, List.map_cons, List.map_map,
      List.map_cons]
    congr 1
    rw [← map_range_getD t]
    refine List.map_congr_left ?_
    intro u _
    show ((a :: t).getD (u + 1) #[]).size = (t.getD u #[]).size
    rw [List.getD_cons_succ]

theorem getD_toList (a : Array (Array (Nat × Nat))) (i : Nat) :
    a.toList.getD i #[] = a.getD i #[] := by
  rw [List.getD_eq_getElem?_getD, Array.getD_eq_getD_getElem?, Array.getElem?_toList]

theorem sum_map_le : ∀ (l : List Nat) (f f' : Nat → Nat),
    (∀ x ∈ l, f x ≤ f' x) → (l.map f).sum ≤ (l.map f').sum
  | [], _, _, _ => Nat.le_refl _
  | a :: t, f, f', h => by
    rw [List.map_cons, List.map_cons, List.sum_cons, List.sum_cons]
    have h1 := h a (.head _)
    have h2 := sum_map_le t f f' (fun x hx => h x (.tail _ hx))
    omega

private theorem undoneOut_le (g : Graph) (st : DState) :
    undoneOut g st ≤ g.adj.foldl (fun acc r => acc + r.size) 0 := by
  have h1 : g.adj.foldl (fun acc r => acc + r.size) 0 =
      (g.adj.toList.map Array.size).sum := by
    rw [← Array.foldl_toList, foldl_add_sum]
    omega
  have h3 : g.adj.toList.length = g.n := Array.length_toList
  have h2 := map_range_getD g.adj.toList
  rw [h3] at h2
  rw [h1, ← h2]
  unfold undoneOut
  refine sum_map_le _ _ _ ?_
  intro x _
  rw [getD_toList]
  by_cases hb : st.done.getD x false = true
  · rw [if_pos hb]
    exact Nat.zero_le _
  · rw [if_neg hb]
    exact Nat.le_refl _

private theorem first_pop (g : Graph) (src : Nat) :
    (initState g src).heap.pop = some ((0, src), ⟨#[]⟩) := by
  have h : (initState g src).heap = ⟨#[(0, src)]⟩ := by
    rw [initState_heap, ← initHeap_a 0 src]
  rw [h]
  rfl

private theorem initHeap_size (g : Graph) (src : Nat) :
    (initState g src).heap.a.size = 1 := by
  rw [initState_heap, initHeap_a]
  rfl

/-- Every real run ends in one of the two legitimate exits, with the
source settled. -/
theorem run_exits {g : Graph} {src dst : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) :
    ∃ L', InvCore g src L' (dijkstraSt g src dst) ∧
      (dijkstraSt g src dst).done.getD src false = true ∧
      (((dijkstraSt g src dst).heap.pop = none ∧ Relaxed g (dijkstraSt g src dst)) ∨
        ((dijkstraSt g src dst).done.getD dst false = true ∧
          (dijkstraSt g src dst).dist.getD dst none = some L' ∧
          RelaxedExcept g dst (dijkstraSt g src dst))) := by
  obtain ⟨hcore0, hrel0⟩ := inv_init g src hsrc
  have hpot : potential g (initState g src) ≤
      g.adj.foldl (fun acc r => acc + r.size) 0 + 1 := by
    unfold potential
    rw [initHeap_size]
    have := undoneOut_le g (initState g src)
    omega
  rw [dijkstraSt_eq]
  rw [show g.adj.foldl (fun acc r => acc + r.size) 0 + g.n + 2 =
      (g.adj.foldl (fun acc r => acc + r.size) 0 + g.n + 1) + 1 from by omega]
  simp only [loop]
  split
  · next hpop =>
    rw [first_pop g src] at hpop
    cases hpop
  · next p u h' hpop =>
    rw [first_pop g src] at hpop
    injection hpop with hpu
    injection hpu with hp1 hh'
    injection hp1 with hp hu
    subst hp
    subst hu
    subst hh'
    rw [if_neg (show ¬(initState g src).done.getD src false = true by
      rw [initDone_getD]; exact Bool.false_ne_true)]
    have hund : (initState g src).done.getD src false = false := initDone_getD g src src
    obtain ⟨hLp, hun, hdu, hrinv⟩ := settle_inv hcore0 hrel0 (first_pop g src) hund
    by_cases hsd : src = dst
    · -- src = dst: the very first settle is the early exit.
      rw [if_pos hsd]
      refine ⟨0, hrinv.core, ?_, .inr ⟨?_, ?_, ?_⟩⟩
      · show ((initState g src).done.setIfInBounds src true).getD src false = true
        rw [getD_set _ (by rw [hcore0.done_size]; exact hun), if_pos rfl]
      · show ((initState g src).done.setIfInBounds src true).getD dst false = true
        rw [← hsd, getD_set _ (by rw [hcore0.done_size]; exact hun), if_pos rfl]
      · rw [← hsd]
        exact hdu
      · intro u' hu' hu'd
        have : (initState g src).done.getD u' false = true := by
          rw [getD_set _ (by rw [hcore0.done_size]; exact hun)] at hu'
          rw [if_neg (show ¬u' = src from fun he => hu'd (he.trans hsd))] at hu'
          exact hu'
        rw [initDone_getD] at this
        cases this
    · rw [if_neg hsd]
      obtain ⟨hinv1, hrel1⟩ := relaxAll_inv hwf hrinv
      have hless := potential_settle (first_pop g src) hun hund hcore0.done_size
      obtain ⟨L', h0L', hinv', hmono', hexit'⟩ :=
        loop_spec g src dst hwf
          (g.adj.foldl (fun acc r => acc + r.size) 0 + g.n + 1)
          _ 0 hinv1 hrel1 (by omega)
      refine ⟨L', hinv', ?_, hexit'⟩
      refine hmono' src ?_
      rw [relaxAll_done]
      show ((initState g src).done.setIfInBounds src true).getD src false = true
      rw [getD_set _ (by rw [hcore0.done_size]; exact hun), if_pos rfl]

/-! ## The goal theorems -/

/-- On any run whose settled `dist` prices `dst`, the rebuilt path passes
the full certificate — the checker never fires on a real run. -/
theorem dijkstra_certifies {g : Graph} {src dst : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (hdst : dst < g.n) {D : Nat}
    (hD : (dijkstraSt g src dst).dist.getD dst none = some D) :
    ∃ p, rebuild (dijkstraSt g src dst).prev g.n (g.n + 1) dst [] = some p ∧
      certify g src dst (dijkstraSt g src dst).done (dijkstraSt g src dst).dist D p
        = true := by
  obtain ⟨L', hcore, hsrcdone, hexit⟩ := run_exits (dst := dst) hwf hsrc
  rcases hexit with ⟨hempty, hrel⟩ | ⟨hdstdone, hdstL, hexc⟩
  · -- Heap exhausted: no unsettled vertex is finite, so dst is settled.
    have hnomem : ∀ z : Nat × Nat, z ∈ (dijkstraSt g src dst).heap.a → False := by
      intro z hz
      have hsz := Heap.pop_none_iff.mp hempty
      obtain ⟨q0, hq0⟩ := Array.mem_iff_getElem?.mp hz
      rw [Array.getElem?_eq_none (by omega)] at hq0
      cases hq0
    have hnocheap : ∀ v, v < g.n → (dijkstraSt g src dst).done.getD v false = false →
        ∀ d', (dijkstraSt g src dst).dist.getD v none = some d' → D ≤ d' := by
      intro v hvn hvd d' hd'
      exact absurd (hcore.undone_heap v hvn hvd d' hd') (hnomem _)
    have hdstdone : (dijkstraSt g src dst).done.getD dst false = true := by
      cases hb : (dijkstraSt g src dst).done.getD dst false with
      | true => rfl
      | false => exact absurd (hcore.undone_heap dst hdst hb D hD) (hnomem _)
    exact exit_certify hwf hcore hsrcdone hdstdone hD (Relaxed.except hrel dst)
      (.inr (hrel dst hdstdone)) hnocheap
  · have hDL : D = L' := Option.some.inj (hD.symm.trans hdstL)
    have hnocheap : ∀ v, v < g.n → (dijkstraSt g src dst).done.getD v false = false →
        ∀ d', (dijkstraSt g src dst).dist.getD v none = some d' → D ≤ d' := by
      intro v hvn hvd d' hd'
      have := hcore.heap_ge (d', v) (hcore.undone_heap v hvn hvd d' hd')
      omega
    exact exit_certify hwf hcore hsrcdone hdstdone hD hexc (.inl hDL) hnocheap

/-- **The pin, retired.** On in-range adjacency the checker never
changes the answer: `dijkstraC = dijkstra`. -/
theorem dijkstraC_eq_dijkstra {g : Graph} (hwf : WFEdges g) (src dst : Nat) :
    dijkstraC g src dst = dijkstra g src dst := by
  by_cases hoob : src ≥ g.n ∨ dst ≥ g.n
  · simp only [dijkstraC, dijkstra]
    rw [if_pos hoob, if_pos hoob]
  · have hsrc : src < g.n := by omega
    have hdst : dst < g.n := by omega
    simp only [dijkstraC, dijkstra]
    rw [if_neg hoob, if_neg hoob]
    cases hd : (dijkstraSt g src dst).dist.getD dst none with
    | none => rfl
    | some D =>
      obtain ⟨p, hreb, hcert⟩ := dijkstra_certifies hwf hsrc hdst hd
      rw [hreb]
      show (if certify g src dst (dijkstraSt g src dst).done (dijkstraSt g src dst).dist
          D p then some p else none) = some p
      rw [if_pos hcert]

/-- All settled vertices reachable along a path from a settled source are
settled once the heap runs dry. -/
private theorem closure_done {g : Graph} {src L : Nat} {st : DState}
    (hwf : WFEdges g) (hcore : InvCore g src L st) (hrel : Relaxed g st)
    (hempty : st.heap.pop = none) :
    ∀ (q : List Nat) (a b : Nat), q.head? = some a → q.getLast? = some b →
      (pathCost g q).isSome = true → st.done.getD a false = true →
      st.done.getD b false = true
  | [], _, _, h, _, _, _ => nomatch h
  | [a'], a, b, hh, hl, _, hda => by
    have he1 : a' = a := by simpa using hh
    have he2 : a' = b := by simpa using hl
    rw [← he2, he1]
    exact hda
  | a' :: b' :: q', a, b, hh, hl, hcs, hda => by
    have he1 : a' = a := by simpa using hh
    have hda' : st.done.getD a' false = true := by
      rw [he1]
      exact hda
    rw [List.getLast?_cons_cons] at hl
    rw [pathCost_cons_cons] at hcs
    cases hw : edgeMinW g a' b' with
    | none =>
      rw [hw] at hcs
      simp at hcs
    | some w =>
      cases hc2 : pathCost g (b' :: q') with
      | none =>
        rw [hw, hc2] at hcs
        simp at hcs
      | some C2 =>
        have hmem := edgeMinW_mem hw
        have han : a' < g.n := hcore.done_lt a' hda'
        obtain ⟨da, hdda, _⟩ := hcore.done_le a' hda'
        obtain ⟨dv, hdv, _⟩ := hrel a' hda' da hdda (b', w) hmem
        have hbn : b' < g.n := hwf a' han (b', w) hmem
        have hbdone : st.done.getD b' false = true := by
          cases hb : st.done.getD b' false with
          | true => rfl
          | false =>
            have hin := hcore.undone_heap b' hbn hb dv hdv
            have hsz := Heap.pop_none_iff.mp hempty
            obtain ⟨q0, hq0⟩ := Array.mem_iff_getElem?.mp hin
            rw [Array.getElem?_eq_none (by omega)] at hq0
            cases hq0
        exact closure_done hwf hcore hrel hempty (b' :: q') b' b rfl hl
          (by rw [hc2]; rfl) hbdone

/-- **Completeness**: a connected pair always yields a path. -/
theorem dijkstra_complete {g : Graph} {src dst : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (hdst : dst < g.n) {D : Nat}
    (hor : oracleDist g src dst = some D) :
    ∃ p, dijkstra g src dst = some p := by
  obtain ⟨c0, hc0⟩ : ∃ c, c ∈ simplePathCosts g dst (g.n + 1) src [src] := by
    unfold oracleDist at hor
    cases henum : simplePathCosts g dst (g.n + 1) src [src] with
    | nil =>
      rw [henum] at hor
      cases hor
    | cons c cs =>
      exact ⟨c, .head _⟩
  obtain ⟨q, C, hqh, hql, hqc, _⟩ := enum_sound (g.n + 1) src [src] c0 hc0
  obtain ⟨L', hcore, hsrcdone, hexit⟩ := run_exits (dst := dst) hwf hsrc
  have hfin : ∃ D', (dijkstraSt g src dst).dist.getD dst none = some D' := by
    rcases hexit with ⟨hempty, hrel⟩ | ⟨hdstdone, hdstL, _⟩
    · have hdstdone := closure_done hwf hcore hrel hempty q src dst hqh hql
        (by rw [hqc]; rfl) hsrcdone
      obtain ⟨d, hd, _⟩ := hcore.done_le dst hdstdone
      exact ⟨d, hd⟩
    · exact ⟨L', hdstL⟩
  obtain ⟨D', hD'⟩ := hfin
  obtain ⟨p, hreb, _⟩ := dijkstra_certifies hwf hsrc hdst hD'
  refine ⟨p, ?_⟩
  simp only [dijkstra]
  rw [if_neg (show ¬(src ≥ g.n ∨ dst ≥ g.n) by omega), hD', hreb]

/-- **The V3 contract, proved end to end**: `none` exactly on
disconnection. -/
theorem dijkstra_none_iff {g : Graph} (hwf : WFEdges g) {src dst : Nat}
    (hsrc : src < g.n) (hdst : dst < g.n) :
    dijkstra g src dst = none ↔ oracleDist g src dst = none := by
  constructor
  · intro hnone
    cases hor : oracleDist g src dst with
    | none => rfl
    | some D =>
      obtain ⟨p, hp⟩ := dijkstra_complete hwf hsrc hdst hor
      rw [hp] at hnone
      cases hnone
  · intro hor
    rw [← dijkstraC_eq_dijkstra hwf src dst]
    exact dijkstraC_disconnected hor

/-- `dijkstraC` inherits completeness through the equality. -/
theorem dijkstraC_complete {g : Graph} {src dst : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (hdst : dst < g.n) {D : Nat}
    (hor : oracleDist g src dst = some D) :
    ∃ p, dijkstraC g src dst = some p := by
  rw [dijkstraC_eq_dijkstra hwf src dst]
  exact dijkstra_complete hwf hsrc hdst hor

end Verified.Rail
