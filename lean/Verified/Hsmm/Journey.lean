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

A leg is a BASE state of the outer model (a walk, a line) or, for S2, a line
WITH ITS BOARD STATION: `train L from σ`. Such a leg shares its base's
emissions, entry and transitions, may begin only at a minute the fixes put
within reach of σ (`reachStarts`), and prices its length by the along-line
path from σ to the station the fixes put the ride's end at (`expectedMin`),
in place of the line's generic duration prior.
-/

namespace Verified.Hsmm.Journey

open Verified.FloatConst (negInf)

/-- The leg problem's tables. `L` legs, `B ≤ L` of them base legs; a leg is
    indexed by its position, its base by `baseOf`. -/
structure Tables where
  T : Nat
  maxJ : Nat
  /-- The outer state index of the journey state. -/
  journey : Nat
  /-- Per leg, the outer state it is written back as. -/
  legs : Array Nat
  /-- Per leg, its name for the debugger: the base state's key, `@station`
      for a board-station leg. -/
  legName : Array String := #[]
  /-- The station a leg boards at (a wait's, a `train L@σ`'s), `none` for a
      leg without one; a decoded wait leaves the assembler named after it. -/
  legStation : Array (Option String) := #[]
  /-- Per leg, its position among the base legs (itself for a base leg). -/
  baseOf : Array Nat
  nBase : Nat
  /-- Per leg, its slot in `legDur`. -/
  legSlot : Array Nat
  nSlots : Nat
  /-- Per base `b`, `emitPre[b * (T + 1) + t]` sums its minute emissions before `t`. -/
  emitPre : FloatArray
  /-- Per base `b`, `entry[b * T + t]`: the entry prior of a leg starting at `t`
      (the train generator's vouching among them). -/
  entry : FloatArray
  /-- `legDur[(slot * maxJ + (d - 1)) * T + e]`: a leg of `d` minutes ending at
      `e`, its duration prior and segment terms WITHOUT the level. -/
  legDur : FloatArray
  /-- `trans[(t * B + a) * B + b]`: into base `b` from base `a` at minute `t`,
      `t` the new leg's first minute. -/
  trans : FloatArray
  /-- Per leg, `log P(first leg)` and `log P(last leg)`. -/
  first : Array Float
  last : Array Float
  /-- Per leg `l`, `firstCtx[l * T + t]`: the chain context of a journey
      beginning in `l` at `t` — a train's fix-anchored boarding term; what the
      flat model charges on a stay → train transition. -/
  firstCtx : FloatArray
  /-- Per leg, the minutes it may begin at, sorted; empty means every minute
      (a base leg). -/
  reachStarts : Array (Array Nat)
  /-- `reachMask[l * T + t]`: `reachStarts` as a lookup. -/
  reachMask : Array Bool
  /-- Per leg `l`, `expectedMin[l * T + e]`: the ride time the pair (its board
      station, the station the fixes put minute `e` at) implies; `−∞` where
      there is no such pair — then the leg keeps its base's duration prior. -/
  expectedMin : FloatArray
  /-- `durBaseF[slot * maxJ + (d - 1)]`: the slot's generic duration prior,
      which a paired leg replaces. -/
  durBaseF : FloatArray
  /-- `pairOk[a * L + b]`: leg `b` may follow leg `a` — the rule beside the base
      matrix (a wait at σ continues only into a ride boarding at σ). -/
  pairOk : Array Bool
  /-- Per leg `l`, `stopPre[l * (T + 1) + t]`: its line's calling evidence at
      the passes before minute `t`, its board station's left out
      (`StationStops`); empty without the record's `stops`. -/
  stopPre : FloatArray := FloatArray.empty
  /-- `stopAlight[l * T + e]`: the leg's alight station at `e` as an index into
      `stopAlightPre`, whose passes the leg leaves out too. -/
  stopAlight : Array (Option Nat) := #[]
  stopAlightPre : Array FloatArray := #[]
  /-- `stopActive[l * T + e]`: the evidence of the leg's passes under way at
      `e` and `stopActiveFirst` the earliest one's first minute
      (`StationStops.activeEvidence`): a pass that runs past the leg's end is
      its arrival, not a call. -/
  stopActive : FloatArray := FloatArray.empty
  stopActiveFirst : Array Nat := #[]
  /-- `best`'s table once computed (`cell[(d - 1) * T + e]`), for the path
      debugger; empty until then. -/
  cell : FloatArray := FloatArray.empty

/-- The ride-time density's spread: a floor in minutes and a fraction of the
    expected time (the station chain's `DURATION_SIGMA_MIN`/`_FRAC`). -/
def PAIR_SIGMA_MIN : Float := 2
def PAIR_SIGMA_FRAC : Float := 0.35
def HALF : Float := 0.5
/-- `−½ log 2π`. -/
def NEG_HALF_LOG_TWO_PI : Float := -0.9189385332046727

/-- `log N(d; expected, σ)`, σ from the expected time. -/
def pairLogPdf (d expected : Float) : Float :=
  let sigma := max PAIR_SIGMA_MIN (PAIR_SIGMA_FRAC * expected)
  let z := (d - expected) / sigma
  NEG_HALF_LOG_TWO_PI - Float.log sigma - HALF * z * z

/-- The leg's calling evidence: the passes whose run lies wholly inside it,
    after its first minute and before its last — a run touching its start is
    the wait at its board station, one touching its end its arrival — and not
    at its own board and alight stations. -/
@[inline] def stopTerm (tb : Tables) (l d e : Nat) : Float :=
  if tb.stopPre.size == 0 then 0 else
  let start := e + 1 - d
  if e < start + 2 then 0 else
  let T1 := tb.T + 1
  -- The runs begun inside, less those still under way at the end.
  let s0 := tb.stopPre.get! (l * T1 + e) - tb.stopPre.get! (l * T1 + start + 1)
  let s := if tb.stopActiveFirst[l * tb.T + e]! > start then s0 - tb.stopActive.get! (l * tb.T + e) else s0
  match tb.stopAlight[l * tb.T + e]? with
  | some (some k) =>
    let ap := tb.stopAlightPre[k]!
    s - (ap.get! e - ap.get! (start + 1))
  | _ => s

/-- The leg's cell: its slot's cell, with the generic duration prior replaced
    by the pair's ride-time density where the leg has a pair at `e`, and its
    calling evidence (`stopTerm`). -/
@[inline] def legCell (tb : Tables) (l d e : Nat) : Float :=
  let slot := tb.legSlot[l]!
  let base := tb.legDur.get! ((slot * tb.maxJ + (d - 1)) * tb.T + e)
  let exp := tb.expectedMin.get! (l * tb.T + e)
  let cell := if exp == negInf then base
    else base - tb.durBaseF.get! (slot * tb.maxJ + (d - 1)) + pairLogPdf (Verified.FloatConst.natToFloat d) exp
  cell + stopTerm tb l d e

/-- One candidate length for leg `l` ending at `s0 + i`: the path before it
    (the first-leg prior at `s0`, else the hoisted transition), its emissions,
    entry and cell. -/
@[inline] def candidate (tb : Tables) (m : FloatArray) (s0 i l d : Nat) : Float :=
  let L := tb.legs.size
  let T := tb.T
  let e := s0 + i
  let start := e + 1 - d
  let prev := if d == i + 1 then tb.first[l]! + tb.firstCtx.get! (l * T + s0)
    else m.get! ((i - d) * L + l)
  if prev == negInf then negInf else
  let b := tb.baseOf[l]!
  let emit := tb.emitPre.get! (b * (T + 1) + e + 1) - tb.emitPre.get! (b * (T + 1) + start)
  prev + emit + tb.entry.get! (b * T + start) + legCell tb l d e

/-- What the hoisted transition needs from `pairOk`, once per table: a leg is
    `restricted` when some leg may not follow it (a wait, which continues only
    into a ride boarding at its station), and `into[l]` lists the restricted
    legs that may precede `l`. Every other pair is free, and the transition's
    price depends on the two legs' bases alone. -/
structure Pre where
  restricted : Array Bool
  into : Array (Array Nat)

def prep (tb : Tables) : Pre := Id.run do
  let L := tb.legs.size
  let restricted := (Array.range L).map fun a => (Array.range L).any fun b => !tb.pairOk[a * L + b]!
  let mut into : Array (Array Nat) := Array.replicate L #[]
  for a in [0:L] do
    if !restricted[a]! then continue
    for b in [0:L] do
      if a != b && tb.pairOk[a * L + b]! then into := into.modify b (·.push a)
  return { restricted, into }

/-- The sweep from `s0` over `w` minutes: `V[i * L + l]`, the best path over
    `[s0, s0 + i]` ending in leg `l`, and its back-pointers (the leg's length;
    a length of `i + 1` is the first leg, and the leg before is `argFrom`). -/
def sweepWith (tb : Tables) (pre : Pre) (s0 w : Nat) : FloatArray × Array Nat := Id.run do
  let L := tb.legs.size
  let B := tb.nBase
  let T := tb.T
  let mut v := FloatArray.mk (Array.replicate (w * L) negInf)
  -- `m[k * L + l]`: the best path ending at `s0 + k` in a leg other than `l`,
  -- plus the transition into `l` at `s0 + k + 1`.
  let mut m := FloatArray.mk (Array.replicate (w * L) negInf)
  let mut bpD := Array.replicate (w * L) 0
  -- Per paired leg, the first of its sorted starts at or after `s0`: the
  -- sweep reads only the starts inside its window, in the same order.
  let firstAt : Array Nat := tb.reachStarts.map fun starts => Id.run do
    let mut lo := 0
    let mut hi := starts.size
    while lo < hi do
      let mid := (lo + hi) / 2
      if starts[mid]! < s0 then lo := mid + 1 else hi := mid
    return lo
  for i in [0:w] do
    let e := s0 + i
    for l in [0:L] do
      let mut best := negInf
      let mut bd := 0
      let starts := tb.reachStarts[l]!
      if starts.isEmpty then
        for d in [1:min tb.maxJ (i + 1) + 1] do
          let cand := candidate tb m s0 i l d
          if cand > best then
            best := cand
            bd := d
      else
        -- A paired leg begins only within reach of its station.
        let mut k := firstAt[l]!
        while k < starts.size && starts[k]! ≤ e do
          let s := starts[k]!
          k := k + 1
          let d := e + 1 - s
          if d > tb.maxJ then continue
          let cand := candidate tb m s0 i l d
          if cand > best then
            best := cand
            bd := d
      v := v.set! (i * L + l) best
      bpD := bpD.set! (i * L + l) bd
    -- The hoisted transition into every leg that may begin at `e + 1`: the
    -- best leg before it, other than itself, plus the transition between their
    -- bases. The price depends on the bases alone, so each base's best and
    -- second-best free leg stand for all of them (the second where the best is
    -- the leg itself); a restricted leg is weighed only where it may precede.
    -- The same maximum as over every pair: `x ↦ x + t` is monotone.
    if i + 1 < w then
      let mut b1 := FloatArray.mk (Array.replicate B negInf)
      let mut b1i : Array Nat := Array.replicate B L
      let mut b2 := FloatArray.mk (Array.replicate B negInf)
      for a in [0:L] do
        if pre.restricted[a]! then continue
        let va := v.get! (i * L + a)
        if va == negInf then continue
        let ba := tb.baseOf[a]!
        if va > b1.get! ba then
          b2 := b2.set! ba (b1.get! ba)
          b1 := b1.set! ba va
          b1i := b1i.set! ba a
        else if va > b2.get! ba then
          b2 := b2.set! ba va
      for l in [0:L] do
        if !tb.reachMask[l * T + (e + 1)]! then continue
        let bl := tb.baseOf[l]!
        let mut best := negInf
        for ba in [0:B] do
          let va := if b1i[ba]! == l then b2.get! ba else b1.get! ba
          if va == negInf then continue
          let cand := va + tb.trans.get! (((e + 1) * B + ba) * B + bl)
          if cand > best then best := cand
        for a in pre.into[l]! do
          let va := v.get! (i * L + a)
          if va == negInf then continue
          let cand := va + tb.trans.get! (((e + 1) * B + tb.baseOf[a]!) * B + bl)
          if cand > best then best := cand
        m := m.set! (i * L + l) best
  return (v, bpD)

def sweep (tb : Tables) (s0 w : Nat) : FloatArray × Array Nat := sweepWith tb (prep tb) s0 w

/-- The leg before `l` in the best path ending at `s0 + k` that continues into
    `l` at `s0 + k + 1`: `m`'s argmax, recomputed from `v`. -/
def argFrom (tb : Tables) (v : FloatArray) (s0 k l : Nat) : Nat := Id.run do
  let L := tb.legs.size
  let B := tb.nBase
  let e := s0 + k
  let bl := tb.baseOf[l]!
  let mut best := negInf
  let mut arg := 0
  for a in [0:L] do
    if a == l then continue
    if !tb.pairOk[a * L + l]! then continue
    let va := v.get! (k * L + a)
    if va == negInf then continue
    let cand := va + tb.trans.get! (((e + 1) * B + tb.baseOf[a]!) * B + bl)
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
  let pre := prep tb
  for s0 in [0:T] do
    let w := min tb.maxJ (T - s0)
    let (v, _) := sweepWith tb pre s0 w
    for i in [0:w] do
      let mut b := negInf
      for l in [0:L] do
        let c := v.get! (i * L + l) + tb.last[l]!
        if c > b then b := c
      out := out.set! (i * T + (s0 + i)) b
  return out

/-- The decoded journey over `[s0, e]` as its legs, first to last: `(leg,
    length)`. -/
def legsPath (tb : Tables) (s0 e : Nat) : Array (Nat × Nat) := Id.run do
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
  let mut out : Array (Nat × Nat) := #[]
  let mut guard := 0
  while guard < w do
    guard := guard + 1
    let d := bpD[i * L + l]!
    out := out.push (l, d)
    if d ≥ i + 1 then break
    let prev := argFrom tb v s0 (i - d) l
    i := i - d
    l := prev
  return out.reverse

/-- The decoded journey over `[s0, e]` as a state per minute: the outer indices
    of its legs. -/
def legsOf (tb : Tables) (s0 e : Nat) : Array Nat := Id.run do
  let mut out := Array.replicate (e + 1 - s0) 0
  let mut k := 0
  for (l, d) in legsPath tb s0 e do
    for _ in [0:d] do
      if k < out.size then out := out.set! k tb.legs[l]!
      k := k + 1
  return out

/-- One leg's terms along a given leg path. -/
structure LegScore where
  leg : Nat
  start : Nat
  d : Nat
  /-- The first-leg prior with its context, or the transition from the leg before. -/
  prev : Float
  emit : Float
  entry : Float
  cell : Float
  expectedMin : Float
  deriving Repr

/-- The legs of a path from `s0`, each with its terms, and the total with the
    last-leg prior: the debugger's view of a journey, decoded or forced. -/
def scoreLegs (tb : Tables) (s0 : Nat) (legs : Array (Nat × Nat)) : Array LegScore × Float := Id.run do
  let B := tb.nBase
  let T := tb.T
  let mut out : Array LegScore := #[]
  let mut total := HALF - HALF
  let mut start := s0
  let mut prevLeg : Option Nat := none
  for (l, d) in legs do
    let e := start + d - 1
    let prev := match prevLeg with
      | none => tb.first[l]! + tb.firstCtx.get! (l * T + s0)
      | some a => if a == l then negInf else tb.trans.get! ((start * B + tb.baseOf[a]!) * B + tb.baseOf[l]!)
    let b := tb.baseOf[l]!
    let emit := tb.emitPre.get! (b * (T + 1) + e + 1) - tb.emitPre.get! (b * (T + 1) + start)
    let entry := tb.entry.get! (b * T + start)
    let cell := legCell tb l d e
    out := out.push { leg := l, start, d, prev, emit, entry, cell, expectedMin := tb.expectedMin.get! (l * T + e) }
    total := total + prev + emit + entry + cell
    start := e + 1
    prevLeg := some l
  match prevLeg with
  | some l => total := total + tb.last[l]!
  | none => pure ()
  return (out, total)

/-- The outer path with every journey segment replaced by its legs; `isJ`
    names the journey states (two, so a long journey can be two in a row). -/
def expand (tb : Tables) (path : Array Nat) (isJ : Nat → Bool := (· == tb.journey)) : Array Nat := Id.run do
  let mut out := path
  let mut i := 0
  while i < path.size do
    if isJ path[i]! then
      let mut j := i
      while j + 1 < path.size && isJ path[j + 1]! && path[j + 1]! == path[i]! do j := j + 1
      let legs := legsOf tb i j
      for k in [0:legs.size] do
        out := out.set! (i + k) legs[k]!
      i := j + 1
    else
      i := i + 1
  return out

/-- The leg each minute inside a journey came from (`none` outside one), the
    companion of `expand` for what a leg knows and its base state does not. -/
def expandLegs (tb : Tables) (path : Array Nat) (isJ : Nat → Bool := (· == tb.journey)) : Array (Option Nat) := Id.run do
  let mut out : Array (Option Nat) := Array.replicate path.size none
  let mut i := 0
  while i < path.size do
    if isJ path[i]! then
      let mut j := i
      while j + 1 < path.size && isJ path[j + 1]! && path[j + 1]! == path[i]! do j := j + 1
      let mut k := i
      for (l, n) in legsPath tb i j do
        for _ in [0:n] do
          if k ≤ j then out := out.set! k (some l)
          k := k + 1
      i := j + 1
    else
      i := i + 1
  return out

-- One leg state, three minutes, emissions 1 a minute, a flat cell of 0: the
-- journey of three minutes scores first + 3 + last, and its legs are the leg.
private def one : Tables :=
  { T := 3, maxJ := 3, journey := 9, legs := #[4], baseOf := #[0], nBase := 1
    legSlot := #[0], nSlots := 1
    emitPre := FloatArray.mk #[0, 1, 2, 3]
    entry := FloatArray.mk #[0, 0, 0]
    legDur := FloatArray.mk (Array.replicate 9 0)
    trans := FloatArray.mk (Array.replicate 3 negInf)
    first := #[-1], last := #[-2], firstCtx := FloatArray.mk #[0, 0, 0]
    reachStarts := #[#[]], reachMask := Array.replicate 3 true
    expectedMin := FloatArray.mk (Array.replicate 3 negInf)
    durBaseF := FloatArray.mk (Array.replicate 3 0)
    pairOk := #[true] }
#guard (best one).get! (2 * 3 + 2) == 0
#guard legsOf one 0 2 == #[4, 4, 4]
#guard expandLegs one #[9, 9, 9] == #[some 0, some 0, some 0]
#guard expandLegs one #[4, 9, 9] (· == 9) == #[none, some 0, some 0]
#guard expand one #[9, 9, 9] == #[4, 4, 4]
-- A paired leg on the same base, reachable only at minute 1: a journey over
-- all three minutes cannot use it; over minutes 1–2 it can, and its cell is
-- the pair's density at its expected time in place of the generic prior (−5).
private def paired : Tables :=
  { one with
    legs := #[4, 4]
    baseOf := #[0, 0]
    legSlot := #[0, 0]
    first := #[-1, -1]
    last := #[-2, -2]
    firstCtx := FloatArray.mk (Array.replicate 6 0)
    reachStarts := #[#[], #[1]]
    reachMask := #[true, true, true, false, true, false]
    expectedMin := FloatArray.mk #[negInf, negInf, negInf, negInf, negInf, 2]
    durBaseF := FloatArray.mk #[-5, -5, -5]
    pairOk := Array.replicate 4 true }
#guard (legsOf paired 0 2) == #[4, 4, 4]
#guard Float.abs ((best paired).get! (1 * 3 + 2) - (-1 + 2 - 2 + 5 + pairLogPdf 2 2)) < 1e-9

end Verified.Hsmm.Journey
