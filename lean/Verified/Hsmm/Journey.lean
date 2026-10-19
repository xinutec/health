import Verified.FloatConst

/-!
# The journey's inner pass

A journey is one segment of the outer trellis; its cell is the best leg path
over its window. For a start `s0` the best path over `[s0, e]` is `Spec.bestEnd`
of the leg problem — `T' = maxJ`, the leg states for `S`, the first-leg prior
for `init`, the leg matrix for `trans`, the level-free segment cell for `dur` —
and one forward sweep from `s0` yields it for every end before `s0 + maxJ`.
`best` runs the sweep from every start into a `maxJ × T` table the outer
duration cell reads; `legsOf` re-runs one window with back-pointers for the
decoded journey's legs. Unproved as code; its specification is `bestEnd`.
-/

namespace Verified.Hsmm.Journey

open Verified.FloatConst (negInf)

/-- The leg problem's tables, all indexed by the LEG's position in `legs`. -/
structure Tables where
  T : Nat
  maxJ : Nat
  /-- The outer state index of the journey state. -/
  journey : Nat
  /-- The outer state indices of the leg states. -/
  legs : Array Nat
  /-- Per leg, its slot in `legDur`. -/
  legSlot : Array Nat
  nSlots : Nat
  /-- Per leg `l`, `emitPre[l * (T + 1) + t]` sums its minute emissions before `t`. -/
  emitPre : FloatArray
  /-- Per leg `l`, `entry[l * T + t]`: the entry prior of a leg starting at `t`
      (the train generator's vouching among them). -/
  entry : FloatArray
  /-- `legDur[(slot * maxJ + (d - 1)) * T + e]`: a leg of `d` minutes ending at
      `e`, its duration prior and segment terms WITHOUT the level. -/
  legDur : FloatArray
  /-- `trans[(t * L + a) * L + b]`: into leg `b` from leg `a` at minute `t`,
      `t` the new leg's first minute. -/
  trans : FloatArray
  /-- Per leg, `log P(first leg)` and `log P(last leg)`. -/
  first : Array Float
  last : Array Float
  /-- Per leg `l`, `firstCtx[l * T + t]`: the chain context of a journey
      beginning in `l` at `t` — a train's fix-anchored boarding term; what the
      flat model charges on a stay → train transition. -/
  firstCtx : FloatArray
  /-- `best`'s table once computed (`cell[(d - 1) * T + e]`), for the path
      debugger; empty until then. -/
  cell : FloatArray := FloatArray.empty

/-- The sweep from `s0` over `w` minutes: `V[i * L + l]`, the best path over
    `[s0, s0 + i]` ending in leg `l`, and its back-pointers (the leg's length and
    the leg before it; a length of `i + 1` is the first leg). -/
def sweep (tb : Tables) (s0 w : Nat) : FloatArray × Array Nat := Id.run do
  let L := tb.legs.size
  let T := tb.T
  let mut v := FloatArray.mk (Array.replicate (w * L) negInf)
  -- `m[k * L + l]`: the best path ending at `s0 + k` in a leg other than `l`,
  -- plus the transition into `l` at `s0 + k + 1`.
  let mut m := FloatArray.mk (Array.replicate (w * L) negInf)
  let mut bpD := Array.replicate (w * L) 0
  for i in [0:w] do
    let e := s0 + i
    for l in [0:L] do
      let slot := tb.legSlot[l]!
      let pre := l * (T + 1)
      let mut best := negInf
      let mut bd := 0
      for d in [1:min tb.maxJ (i + 1) + 1] do
        let prev := if d == i + 1 then tb.first[l]! + tb.firstCtx.get! (l * T + s0)
          else m.get! ((i - d) * L + l)
        if prev == negInf then continue
        let emit := tb.emitPre.get! (pre + e + 1) - tb.emitPre.get! (pre + e + 1 - d)
        let cand := prev + emit + tb.entry.get! (l * T + (e + 1 - d))
          + tb.legDur.get! ((slot * tb.maxJ + (d - 1)) * T + e)
        if cand > best then
          best := cand
          bd := d
      v := v.set! (i * L + l) best
      bpD := bpD.set! (i * L + l) bd
    -- The hoisted transition into every leg at `e + 1`, and who it came from.
    if i + 1 < w then
      for l in [0:L] do
        let mut best := negInf
        for a in [0:L] do
          if a == l then continue
          let va := v.get! (i * L + a)
          if va == negInf then continue
          let cand := va + tb.trans.get! (((e + 1) * L + a) * L + l)
          if cand > best then best := cand
        m := m.set! (i * L + l) best
  return (v, bpD)

/-- The leg before `l` in the best path ending at `s0 + k` that continues into
    `l` at `s0 + k + 1`: `m`'s argmax, recomputed from `v`. -/
def argFrom (tb : Tables) (v : FloatArray) (s0 k l : Nat) : Nat := Id.run do
  let L := tb.legs.size
  let e := s0 + k
  let mut best := negInf
  let mut arg := 0
  for a in [0:L] do
    if a == l then continue
    let va := v.get! (k * L + a)
    if va == negInf then continue
    let cand := va + tb.trans.get! (((e + 1) * L + a) * L + l)
    if cand > best then
      best := cand
      arg := a
  return arg

/-- `best[(d - 1) * T + e]`: the best leg path over the journey of `d` minutes
    ending at `e`, with the last-leg prior; `−∞` where none fits. -/
def best (tb : Tables) : FloatArray := Id.run do
  let L := tb.legs.size
  let T := tb.T
  let mut out := FloatArray.mk (Array.replicate (tb.maxJ * T) negInf)
  for s0 in [0:T] do
    let w := min tb.maxJ (T - s0)
    let (v, _) := sweep tb s0 w
    for i in [0:w] do
      let mut b := negInf
      for l in [0:L] do
        let c := v.get! (i * L + l) + tb.last[l]!
        if c > b then b := c
      out := out.set! (i * T + (s0 + i)) b
  return out

/-- The decoded journey over `[s0, e]` as a state per minute: the outer indices
    of its legs. -/
def legsOf (tb : Tables) (s0 e : Nat) : Array Nat := Id.run do
  let L := tb.legs.size
  let w := e + 1 - s0
  let (v, bpD) := sweep tb s0 w
  let mut i := w - 1
  let mut l := 0
  let mut b := negInf
  for c in [0:L] do
    let x := v.get! (i * L + c) + tb.last[c]!
    if x > b then
      b := x
      l := c
  let mut out := Array.replicate w 0
  let mut guard := 0
  while guard < w do
    guard := guard + 1
    let d := bpD[i * L + l]!
    for k in [i + 1 - d:i + 1] do
      out := out.set! k tb.legs[l]!
    if d ≥ i + 1 then break
    let prev := argFrom tb v s0 (i - d) l
    i := i - d
    l := prev
  return out

/-- The outer path with every journey segment replaced by its legs. -/
def expand (tb : Tables) (path : Array Nat) : Array Nat := Id.run do
  let mut out := path
  let mut i := 0
  while i < path.size do
    if path[i]! == tb.journey then
      let mut j := i
      while j + 1 < path.size && path[j + 1]! == tb.journey do j := j + 1
      let legs := legsOf tb i j
      for k in [0:legs.size] do
        out := out.set! (i + k) legs[k]!
      i := j + 1
    else
      i := i + 1
  return out

-- One leg state, three minutes, emissions 1 a minute, a flat cell of 0: the
-- journey of three minutes scores first + 3 + last, and its legs are the leg.
private def one : Tables :=
  { T := 3, maxJ := 3, journey := 9, legs := #[4], legSlot := #[0], nSlots := 1
    emitPre := FloatArray.mk #[0, 1, 2, 3]
    entry := FloatArray.mk #[0, 0, 0]
    legDur := FloatArray.mk (Array.replicate 9 0)
    trans := FloatArray.mk (Array.replicate 3 negInf)
    first := #[-1], last := #[-2], firstCtx := FloatArray.mk #[0, 0, 0] }
#guard (best one).get! (2 * 3 + 2) == 0
#guard legsOf one 0 2 == #[4, 4, 4]
#guard expand one #[9, 9, 9] == #[4, 4, 4]

end Verified.Hsmm.Journey
