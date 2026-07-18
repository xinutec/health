import Verified.Rail.Dijkstra

/-!
# Certified shortest path — the V3 goal theorems

`dijkstra` is a faithful port of imperative production code (binary heap,
lazy deletion, fuel); proving the *algorithm* correct would mean invariants
over all of that machinery. This file takes the certifying route instead:
the search runs untrusted, then a proved O(E) checker (`certify`) validates
what the result *claims* —

* the returned path is a valid simple `src → dst` path whose cost equals
  the settled distance `D`, and
* the final `done`/`dist` arrays form a **feasible cut** (`feasibleCut`):
  every edge out of a settled vertex `u` either stays inside the settled
  set without shortcutting it (`dist v ≤ dist u + w`), or crosses out of
  it at cost already `≥ D`.

The cut condition is exactly what the textbook "Dijkstra settles vertices
in distance order" argument leaves behind at early exit, so it holds on
every real run — but the theorems never depend on that: `cut_bound` shows
the condition *itself* forces `D ≤` the cost of every `src → dst` path,
and with the enumeration lemmas (`enum_sound`, `enum_complete`) that pins
`oracleDist = some D`.

`dijkstraC` wraps the search in the checker. `dijkstraC_correct` — any
returned path is valid and attains `oracleDist` — and
`dijkstraC_disconnected` — disconnected endpoints yield `none` — are the
null-over-wrong contract: a certification failure degrades to `none`
(draw raw GPS), never to a wrong line. The converse ("the checker never
fires on a real run") is `#guard`-pinned in `Tests.lean` and pinned on
real corridors by `npm run compare-rail`, pending the algorithm-invariant
upgrade.
-/

namespace Verified.Rail

/-- `l` has no duplicate vertices. -/
def nodupB : List Nat → Bool
  | [] => true
  | a :: l => !l.contains a && nodupB l

/-- The cut condition over the search's final arrays: for every settled
`u` (with its settled distance `du`), each edge `u → v` satisfies
`dist v ≤ du + w` if `v` is settled, and `D ≤ du + w` if not. -/
def feasibleCut (g : Graph) (done : Array Bool) (dist : Array (Option Nat)) (D : Nat) : Bool :=
  (List.range g.n).all fun u =>
    !done.getD u false ||
      match dist.getD u none with
      | none => false
      | some du =>
        (g.adj.getD u #[]).toList.all fun tw =>
          decide (tw.1 < g.n) &&
            if done.getD tw.1 false then
              match dist.getD tw.1 none with
              | none => false
              | some dv => decide (dv ≤ du + tw.2)
            else decide (D ≤ du + tw.2)

/-- Everything the goal theorems need, as one executable check: a valid
simple path `src → dst` of cost exactly `D`, short enough for the oracle's
fuel, endpoints priced and settled correctly, and the feasible cut. -/
def certify (g : Graph) (src dst : Nat) (done : Array Bool) (dist : Array (Option Nat))
    (D : Nat) (p : List Nat) : Bool :=
  isValidPath g src dst p &&
  p.head? == some src &&
  p.getLast? == some dst &&
  pathCost g p == some D &&
  nodupB p &&
  decide (p.length ≤ g.n + 1) &&
  decide (src < g.n) &&
  dist.getD src none == some 0 &&
  dist.getD dst none == some D &&
  done.getD src false &&
  feasibleCut g done dist D

/-- `dijkstra` with the proved checker behind it: a returned path carries
the `dijkstraC_correct` guarantee; a certification failure returns `none`
(honest refusal, same contract as the other `none`s). -/
def dijkstraC (g : Graph) (src dst : Nat) : Option (List Nat) :=
  if src ≥ g.n ∨ dst ≥ g.n then none
  else
    let st := dijkstraSt g src dst
    match st.dist.getD dst none with
    | none => none
    | some D =>
      match rebuild st.prev g.n (g.n + 1) dst [] with
      | none => none
      | some p => if certify g src dst st.done st.dist D p then some p else none

/-! ## Fold lemmas: `edgeMinW` attainment and minimality -/

/-- The fold step of `edgeMinW`, named so list inductions can speak
about it. -/
private def stepMin (v : Nat) (acc : Option Nat) (tw : Nat × Nat) : Option Nat :=
  if tw.1 = v then
    match acc with
    | none => some tw.2
    | some w => some (Nat.min w tw.2)
  else acc

private theorem edgeMinW_eq_foldl (g : Graph) (u v : Nat) :
    edgeMinW g u v = (g.adj.getD u #[]).toList.foldl (stepMin v) none := by
  rw [Array.foldl_toList]
  rfl

private theorem foldl_stepMin_attain (v : Nat) :
    ∀ (l : List (Nat × Nat)) (acc : Option Nat) (w : Nat),
      l.foldl (stepMin v) acc = some w → acc = some w ∨ (v, w) ∈ l := by
  intro l
  induction l with
  | nil => intro acc w h; exact .inl h
  | cons tw l ih =>
    obtain ⟨t, wt⟩ := tw
    intro acc w h
    rw [List.foldl_cons] at h
    rcases ih _ w h with h' | h'
    · by_cases ht : t = v
      · cases hacc : acc with
        | none =>
          rw [hacc] at h'
          simp only [stepMin, if_pos ht] at h'
          injection h' with hw
          exact .inr (by rw [← hw, ← ht]; exact .head _)
        | some w0 =>
          rw [hacc] at h'
          simp only [stepMin, if_pos ht] at h'
          injection h' with hw
          -- min picks one of its arguments.
          have hw' : min w0 wt = w := hw
          rw [Nat.min_def] at hw'
          split at hw'
          · exact .inl (by rw [hw'])
          · exact .inr (by rw [← hw', ← ht]; exact .head _)
      · simp only [stepMin, if_neg ht] at h'
        exact .inl h'
    · exact .inr (List.mem_cons_of_mem _ h')

/-- With a `some` accumulator the fold stays `some` and never increases. -/
private theorem foldl_stepMin_mono (v : Nat) :
    ∀ (l : List (Nat × Nat)) (w0 : Nat),
      ∃ w, l.foldl (stepMin v) (some w0) = some w ∧ w ≤ w0 := by
  intro l
  induction l with
  | nil => exact fun w0 => ⟨w0, rfl, Nat.le_refl _⟩
  | cons tw l ih =>
    obtain ⟨t, wt⟩ := tw
    intro w0
    rw [List.foldl_cons]
    by_cases ht : t = v
    · simp only [stepMin, if_pos ht]
      obtain ⟨w, hw, hle⟩ := ih (Nat.min w0 wt)
      exact ⟨w, hw, Nat.le_trans hle (Nat.min_le_left _ _)⟩
    · simp only [stepMin, if_neg ht]
      exact ih w0

private theorem foldl_stepMin_le_mem (v : Nat) :
    ∀ (l : List (Nat × Nat)) (acc : Option Nat) (w' : Nat), (v, w') ∈ l →
      ∃ w, l.foldl (stepMin v) acc = some w ∧ w ≤ w' := by
  intro l
  induction l with
  | nil => intro _ _ h; cases h
  | cons tw l ih =>
    obtain ⟨t, wt⟩ := tw
    intro acc w' hmem
    rw [List.foldl_cons]
    rcases List.mem_cons.mp hmem with heq | htail
    · -- The head is the matching edge: the accumulator drops to ≤ w'.
      injection heq with hv hw
      cases hacc : acc with
      | none =>
        simp only [stepMin, if_pos hv.symm]
        obtain ⟨w, hfold, hle⟩ := foldl_stepMin_mono v l wt
        exact ⟨w, hfold, by omega⟩
      | some w0 =>
        simp only [stepMin, if_pos hv.symm]
        obtain ⟨w, hfold, hle⟩ := foldl_stepMin_mono v l (Nat.min w0 wt)
        have : Nat.min w0 wt ≤ wt := Nat.min_le_right _ _
        exact ⟨w, hfold, by omega⟩
    · exact ih (stepMin v acc (t, wt)) w' htail

/-- `edgeMinW = some w` names an actual edge. -/
theorem edgeMinW_mem {g : Graph} {u v w : Nat} (h : edgeMinW g u v = some w) :
    (v, w) ∈ (g.adj.getD u #[]).toList := by
  rw [edgeMinW_eq_foldl] at h
  rcases foldl_stepMin_attain v _ none w h with h' | h'
  · cases h'
  · exact h'

/-- Every edge `u → v` bounds `edgeMinW` from above. -/
theorem edgeMinW_le_of_mem {g : Graph} {u v w' : Nat}
    (h : (v, w') ∈ (g.adj.getD u #[]).toList) :
    ∃ w, edgeMinW g u v = some w ∧ w ≤ w' := by
  rw [edgeMinW_eq_foldl]
  exact foldl_stepMin_le_mem v _ none w' h

/-! ## Small list lemmas -/

theorem nodupB_cons (a : Nat) (l : List Nat) :
    nodupB (a :: l) = (!l.contains a && nodupB l) := rfl

theorem mem_of_getLast? : ∀ {l : List Nat} {x : Nat}, l.getLast? = some x → x ∈ l
  | [], _, h => by cases h
  | [a], x, h => by
    simp only [List.getLast?_singleton, Option.some.injEq] at h
    exact h ▸ List.mem_singleton_self a
  | _ :: b :: l, x, h => by
    rw [List.getLast?_cons_cons] at h
    exact List.mem_cons_of_mem _ (mem_of_getLast? h)

private theorem foldl_min_le_self : ∀ (l : List Nat) (a : Nat), l.foldl Nat.min a ≤ a := by
  intro l
  induction l with
  | nil => exact fun a => Nat.le_refl a
  | cons x l ih =>
    intro a
    rw [List.foldl_cons]
    exact Nat.le_trans (ih (Nat.min a x)) (Nat.min_le_left _ _)

private theorem foldl_min_le_mem :
    ∀ (l : List Nat) (a x : Nat), x ∈ l → l.foldl Nat.min a ≤ x := by
  intro l
  induction l with
  | nil => intro _ _ h; cases h
  | cons y l ih =>
    intro a x hmem
    rw [List.foldl_cons]
    rcases List.mem_cons.mp hmem with heq | htail
    · subst heq
      exact Nat.le_trans (foldl_min_le_self l _) (Nat.min_le_right _ _)
    · exact ih _ x htail

private theorem le_foldl_min :
    ∀ (l : List Nat) (a b : Nat), b ≤ a → (∀ x ∈ l, b ≤ x) → b ≤ l.foldl Nat.min a := by
  intro l
  induction l with
  | nil => exact fun _ _ h _ => h
  | cons x l ih =>
    intro a b hb hall
    rw [List.foldl_cons]
    exact ih _ b (Nat.le_min.mpr ⟨hb, hall x (.head _)⟩) fun y hy => hall y (.tail _ hy)

/-- One-step unfolding of `pathCost` on two or more vertices. -/
theorem pathCost_cons_cons (g : Graph) (a b : Nat) (rest : List Nat) :
    pathCost g (a :: b :: rest) =
      match edgeMinW g a b, pathCost g (b :: rest) with
      | some w, some c => some (w + c)
      | _, _ => none := by
  cases hw : edgeMinW g a b <;> cases hc : pathCost g (b :: rest) <;>
    simp [pathCost, hw, hc]

/-! ## The cut bound -/

/-- Extraction form of `feasibleCut`. -/
private theorem feasibleCut_spec {g : Graph} {done : Array Bool}
    {dist : Array (Option Nat)} {D : Nat} (h : feasibleCut g done dist D = true)
    {u du : Nat} (hu : u < g.n) (hdone : done.getD u false = true)
    (hdu : dist.getD u none = some du) {tw : Nat × Nat}
    (htw : tw ∈ (g.adj.getD u #[]).toList) :
    tw.1 < g.n ∧
      (if done.getD tw.1 false then
        ∃ dv, dist.getD tw.1 none = some dv ∧ dv ≤ du + tw.2
      else D ≤ du + tw.2) := by
  have hall := (List.all_eq_true.mp h) u (List.mem_range.mpr hu)
  simp only [hdone, Bool.not_true, Bool.false_or, hdu] at hall
  have hcond := (List.all_eq_true.mp hall) tw htw
  rw [Bool.and_eq_true] at hcond
  obtain ⟨hlt, hbranch⟩ := hcond
  refine ⟨of_decide_eq_true hlt, ?_⟩
  by_cases hd : done.getD tw.1 false = true
  · rw [if_pos hd] at hbranch ⊢
    cases hdv : dist.getD tw.1 none with
    | none => simp [hdv] at hbranch
    | some dv =>
      simp only [hdv] at hbranch
      exact ⟨dv, rfl, of_decide_eq_true hbranch⟩
  · rw [if_neg hd] at hbranch ⊢
    exact of_decide_eq_true hbranch

/-- The heart of the correctness argument: a feasible cut forces `D` to
lower-bound the cost of **every** path from a settled, correctly-priced
vertex to `dst` — walk the path while it stays settled (chaining the
no-shortcut inequality), and the first crossing edge already costs `≥ D`. -/
theorem cut_bound {g : Graph} {done : Array Bool} {dist : Array (Option Nat)}
    {D : Nat} {dst : Nat} (hfeas : feasibleCut g done dist D = true)
    (hdst : dist.getD dst none = some D) :
    ∀ (p : List Nat) (u du C : Nat), p.head? = some u → p.getLast? = some dst →
      pathCost g p = some C → done.getD u false = true → u < g.n →
      dist.getD u none = some du → D ≤ du + C := by
  intro p
  induction p with
  | nil => intro u du C h; cases h
  | cons a rest ih =>
    intro u du C hhead hlast hcost hdone hun hdu
    obtain rfl : a = u := by simpa using hhead
    cases rest with
    | nil =>
      -- Single vertex: it *is* dst, and its settled price is D.
      obtain rfl : a = dst := by simpa using hlast
      simp only [pathCost, Option.some.injEq] at hcost
      rw [hdu] at hdst
      injection hdst with hD
      omega
    | cons b rest' =>
      rw [List.getLast?_cons_cons] at hlast
      rw [pathCost_cons_cons] at hcost
      cases hw : edgeMinW g a b with
      | none => rw [hw] at hcost; cases hcost
      | some w =>
        cases hc' : pathCost g (b :: rest') with
        | none => rw [hw, hc'] at hcost; cases hcost
        | some C' =>
          rw [hw, hc'] at hcost
          injection hcost with hC
          have hspec := feasibleCut_spec hfeas hun hdone hdu (tw := (b, w)) (edgeMinW_mem hw)
          obtain ⟨hbn, hbranch⟩ := hspec
          by_cases hbd : done.getD b false = true
          · rw [if_pos hbd] at hbranch
            obtain ⟨dv, hdv, hle⟩ := hbranch
            have := ih b dv C' rfl hlast hc' hbd hbn hdv
            omega
          · rw [if_neg hbd] at hbranch
            omega

/-! ## Oracle enumeration: soundness and completeness -/

/-- Every enumerated cost is over-approximated by a real path's cost. -/
theorem enum_sound {g : Graph} {dst : Nat} :
    ∀ (fuel cur : Nat) (visited : List Nat) (c : Nat),
      c ∈ simplePathCosts g dst fuel cur visited →
      ∃ (p : List Nat) (C : Nat), p.head? = some cur ∧ p.getLast? = some dst ∧
        pathCost g p = some C ∧ C ≤ c := by
  intro fuel
  induction fuel with
  | zero => intro cur visited c h; simp [simplePathCosts] at h
  | succ fuel ih =>
    intro cur visited c h
    simp only [simplePathCosts] at h
    by_cases hcd : cur = dst
    · rw [if_pos hcd] at h
      have hc : c = 0 := by simpa using h
      exact ⟨[cur], 0, rfl, by simp [hcd], by simp [pathCost], by omega⟩
    · rw [if_neg hcd] at h
      obtain ⟨tw, htw, hc⟩ := List.mem_flatMap.mp h
      by_cases hvis : visited.contains tw.1 = true
      · rw [if_pos hvis] at hc
        cases hc
      · rw [if_neg hvis] at hc
        obtain ⟨c', hc', hce⟩ := List.mem_map.mp hc
        obtain ⟨p', C', hh, hl, hpc, hle⟩ := ih tw.1 (tw.1 :: visited) c' hc'
        cases p' with
        | nil => simp at hh
        | cons b rest =>
          have hb : b = tw.1 := by simpa using hh
          have hmem : (b, tw.2) ∈ (g.adj.getD cur #[]).toList := by
            rw [hb]; exact htw
          obtain ⟨w, hw, hwle⟩ := edgeMinW_le_of_mem hmem
          refine ⟨cur :: b :: rest, w + C', rfl, ?_, ?_, ?_⟩
          · rw [List.getLast?_cons_cons]; exact hl
          · simp only [pathCost_cons_cons, hw, hpc]
          · omega

/-- Every short-enough simple path is matched (or beaten, via cheapest
parallel edges) by an enumerated cost. -/
private theorem enum_complete {g : Graph} {dst : Nat} :
    ∀ (p : List Nat) (fuel cur : Nat) (visited : List Nat) (C : Nat),
      p.head? = some cur → p.getLast? = some dst → pathCost g p = some C →
      nodupB p = true → (∀ x ∈ p.tail, ¬ x ∈ visited) → p.length ≤ fuel →
      ∃ c ∈ simplePathCosts g dst fuel cur visited, c ≤ C := by
  intro p
  induction p with
  | nil => intro fuel cur visited C h; cases h
  | cons a rest ih =>
    intro fuel cur visited C hhead hlast hcost hnd hdisj hlen
    obtain rfl : a = cur := by simpa using hhead
    cases fuel with
    | zero => simp at hlen
    | succ fuel =>
      cases rest with
      | nil =>
        obtain rfl : a = dst := by simpa using hlast
        simp only [pathCost, Option.some.injEq] at hcost
        rw [simplePathCosts, if_pos rfl]
        exact ⟨0, by simp, by omega⟩
      | cons b rest' =>
        rw [List.getLast?_cons_cons] at hlast
        rw [nodupB_cons, Bool.and_eq_true] at hnd
        obtain ⟨hnc, hnd'⟩ := hnd
        rw [Bool.not_eq_true'] at hnc
        -- a ≠ dst: dst sits in the tail, which nodup keeps a out of.
        have hcd : a ≠ dst := by
          intro he
          have : a ∈ b :: rest' := he ▸ mem_of_getLast? hlast
          rw [← List.contains_iff_mem, hnc] at this
          cases this
        rw [pathCost_cons_cons] at hcost
        cases hw : edgeMinW g a b with
        | none => rw [hw] at hcost; cases hcost
        | some w =>
          cases hc' : pathCost g (b :: rest') with
          | none => rw [hw, hc'] at hcost; cases hcost
          | some C' =>
            rw [hw, hc'] at hcost
            injection hcost with hC
            -- Nodup of the tail, for the recursive call.
            have hnb : rest'.contains b = false := by
              have hnd'' := hnd'
              rw [nodupB_cons, Bool.and_eq_true] at hnd''
              have h1 := hnd''.1
              rw [Bool.not_eq_true'] at h1
              exact h1
            have hdisj' : ∀ x ∈ (b :: rest').tail, ¬ x ∈ (b :: visited) := by
              intro x hx hmem
              rw [List.tail_cons] at hx
              rcases List.mem_cons.mp hmem with hxb | hxv
              · rw [hxb] at hx
                rw [← List.contains_iff_mem, hnb] at hx
                cases hx
              · exact hdisj x (.tail _ hx) hxv
            obtain ⟨c', hc'mem, hc'le⟩ :=
              ih fuel b (b :: visited) C' rfl hlast hc' hnd' hdisj' (by simpa using hlen)
            have hbv : ¬ b ∈ visited := hdisj b (.head _)
            have hvc : ¬ visited.contains b = true := by
              rw [List.contains_iff_mem]; exact hbv
            refine ⟨w + c', ?_, by omega⟩
            rw [simplePathCosts, if_neg hcd]
            refine List.mem_flatMap.mpr ⟨(b, w), edgeMinW_mem hw, ?_⟩
            rw [if_neg hvc]
            exact List.mem_map.mpr ⟨c', hc'mem, rfl⟩

/-! ## The goal theorems -/

/-- A passing certificate pins the oracle: the path is valid, costs `D`,
and `D` is exactly the simple-path minimum. -/
theorem certify_oracle {g : Graph} {src dst : Nat} {done : Array Bool}
    {dist : Array (Option Nat)} {D : Nat} {p : List Nat}
    (h : certify g src dst done dist D p = true) :
    isValidPath g src dst p = true ∧ pathCost g p = some D ∧
      oracleDist g src dst = some D := by
  simp only [certify, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at h
  obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨hvalid, hhead⟩, hlast⟩, hcost⟩, hnd⟩, hlen⟩, hsrcn⟩,
    hsrc0⟩, hdstD⟩, hsrcdone⟩, hfeas⟩ := h
  refine ⟨hvalid, hcost, ?_⟩
  -- Lower bound: every enumerated cost is a path cost, and the cut bounds
  -- every path cost from below by D.
  have hlow : ∀ c ∈ simplePathCosts g dst (g.n + 1) src [src], D ≤ c := by
    intro c hc
    obtain ⟨q, C, hqh, hql, hqc, hqle⟩ := enum_sound _ _ _ _ hc
    have := cut_bound hfeas hdstD q src 0 C hqh hql hqc hsrcdone hsrcn hsrc0
    omega
  -- Membership: the certified path itself is enumerated (at cost ≤ D, so
  -- with the lower bound, exactly D).
  have hdisj : ∀ x ∈ p.tail, ¬ x ∈ ([src] : List Nat) := by
    cases p with
    | nil => cases hhead
    | cons a rest =>
      obtain rfl : a = src := by simpa using hhead
      rw [nodupB_cons, Bool.and_eq_true] at hnd
      have hnc := hnd.1
      rw [Bool.not_eq_true'] at hnc
      intro x hx hmem
      rw [List.tail_cons] at hx
      obtain rfl : x = a := by simpa using hmem
      rw [← List.contains_iff_mem, hnc] at hx
      cases hx
  obtain ⟨c0, hc0mem, hc0le⟩ :=
    enum_complete p (g.n + 1) src [src] D hhead hlast hcost hnd hdisj hlen
  have hc0 : c0 = D := Nat.le_antisymm hc0le (hlow c0 hc0mem)
  -- Assemble: the enumeration is nonempty and its running minimum is D.
  unfold oracleDist
  cases henum : simplePathCosts g dst (g.n + 1) src [src] with
  | nil => rw [henum] at hc0mem; cases hc0mem
  | cons c cs =>
    rw [henum] at hc0mem hlow
    have hcD : D ≤ c := hlow c (.head _)
    have hup : cs.foldl Nat.min c ≤ D := by
      rcases List.mem_cons.mp hc0mem with he | ht
      · have hcD' : c = D := by omega
        rw [← hcD']
        exact foldl_min_le_self cs c
      · rw [← hc0]; exact foldl_min_le_mem cs c c0 ht
    have hdown : D ≤ cs.foldl Nat.min c :=
      le_foldl_min cs c D hcD fun x hx => hlow x (.tail _ hx)
    show some (cs.foldl Nat.min c) = some D
    rw [Nat.le_antisymm hup hdown]

/-- **V3 goal theorem (soundness).** Any path `dijkstraC` returns is a
valid `src → dst` path attaining the true simple-path minimum. -/
theorem dijkstraC_correct {g : Graph} {src dst : Nat} {p : List Nat}
    (h : dijkstraC g src dst = some p) :
    isValidPath g src dst p = true ∧ pathCost g p = oracleDist g src dst := by
  simp only [dijkstraC] at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · rename_i hcert
          injection h with hqp
          subst hqp
          obtain ⟨hvalid, hcost, horacle⟩ := certify_oracle hcert
          exact ⟨hvalid, by rw [hcost, horacle]⟩
        · cases h

/-- **V3 goal theorem (never wrong on disconnection).** If no `src → dst`
path exists, `dijkstraC` cannot return one. -/
theorem dijkstraC_disconnected {g : Graph} {src dst : Nat}
    (h : oracleDist g src dst = none) : dijkstraC g src dst = none := by
  cases hd : dijkstraC g src dst with
  | none => rfl
  | some p =>
    obtain ⟨hvalid, hcost⟩ := dijkstraC_correct hd
    rw [h] at hcost
    cases p with
    | nil => simp [isValidPath] at hvalid
    | cons v rest =>
      simp only [isValidPath, Bool.and_eq_true] at hvalid
      have hsome := hvalid.2
      rw [hcost] at hsome
      simp at hsome

end Verified.Rail
