import Verified.Hsmm.Packed
import Verified.Hsmm.Quantize
/-!
# Posterior marginals over the decoder's own trellis

The Viterbi path says what the day most likely was; this says how sure it is.
Forward–backward over exactly the packed tensors the verified decode reads
(`PData`): the same segmental model — a segment pays `init` or the transition
at its start, `entry` there, its emissions, and its duration prior at its last
minute, and two consecutive segments differ in state — with log-sum-exp where
the decode takes a maximum.

It runs in `Float`, outside the verified envelope, and decides nothing the
decode decides: what it returns is, per minute, each state's posterior mass.
-/

namespace Verified.Hsmm.Posterior

private def NEG_INF : Float := -1.0 / 0.0
private def ZERO : Float := 0.0
private def ONE : Float := 1.0
/-- A segment this far below the total adds nothing a minute's mass can show. -/
private def NEGLIGIBLE : Float := -40.0

/-- A packed score as nats: `0` is `-∞`, otherwise `(n − 2⁶¹) / 2²⁰`, in machine
    words — an `Int` past 2³¹ is a GMP number (see `encScore`). -/
@[inline] def nats (n : Nat) : Float :=
  if n == 0 then NEG_INF
  else
    let w := (n.toUInt64 - pOff.toUInt64).toInt64
    w.toFloat / Verified.Hsmm.Quantize.SCALE

/-- One step of a streaming log-sum-exp: `(m, acc)` holds `m + log acc`. -/
@[inline] def lseStep (st : Float × Float) (x : Float) : Float × Float :=
  let (m, acc) := st
  if x == NEG_INF then st
  else if m == NEG_INF then (x, ONE)
  else if x > m then (x, acc * Float.exp (m - x) + ONE)
  else (m, acc + Float.exp (x - m))

@[inline] def lseDone (st : Float × Float) : Float :=
  if st.1 == NEG_INF then NEG_INF else st.1 + Float.log st.2

/-- Per-minute posterior state marginals, `T × S` row-major; empty when every
    path is impossible. -/
def marginals (d : PData) : Array Float := Id.run do
  let T := d.T
  let S := d.S
  if T == 0 || S == 0 then return #[]
  -- Emission prefix sums, the finite part and the count of `-∞` minutes kept
  -- apart: a run with an impossible minute is impossible, and `-∞ − -∞` is not.
  let mut C : Array Float := Array.replicate ((T + 1) * S) ZERO
  let mut K : Array Nat := Array.replicate ((T + 1) * S) 0
  for t in [0:T] do
    for s in [0:S] do
      let e := nats (d.emitAt t s)
      let i := t * S + s
      let j := (t + 1) * S + s
      if e == NEG_INF then
        C := C.set! j C[i]!
        K := K.set! j (K[i]! + 1)
      else
        C := C.set! j (C[i]! + e)
        K := K.set! j K[i]!
  -- The run of `s` over minutes `a..b`.
  let run := fun (C : Array Float) (K : Array Nat) (s a b : Nat) =>
    if K[(b + 1) * S + s]! != K[a * S + s]! then NEG_INF
    else C[(b + 1) * S + s]! - C[a * S + s]!
  -- Forward. `St[a·S + s]`: everything before a segment of `s` starting at `a`,
  -- its entry included. `F[b·S + s]`: a segment of `s` closed at `b`.
  let mut F : Array Float := Array.replicate (T * S) NEG_INF
  let mut St : Array Float := Array.replicate (T * S) NEG_INF
  for b in [0:T] do
    for s in [0:S] do
      let before :=
        if b == 0 then nats (d.initAt s)
        else Id.run do
          let mut st := (NEG_INF, ZERO)
          for sp in [0:S] do
            if sp != s then
              st := lseStep st (F[(b - 1) * S + sp]! + nats (d.transAt sp s b))
          return lseDone st
      St := St.set! (b * S + s) (before + nats (d.entryAt s b))
    for s in [0:S] do
      let mut st := (NEG_INF, ZERO)
      for i in [0:min d.maxD (b + 1)] do
        let dd := i + 1
        let a := b + 1 - dd
        let x := St[a * S + s]!
        if x != NEG_INF then
          st := lseStep st (x + run C K s a b + nats (d.durAt s dd b))
      F := F.set! (b * S + s) (lseDone st)
  let Z := Id.run do
    let mut st := (NEG_INF, ZERO)
    for s in [0:S] do st := lseStep st F[(T - 1) * S + s]!
    return lseDone st
  if Z == NEG_INF then return #[]
  -- Backward. `Bk[b·S + s]`: everything after a segment of `s` closed at `b`.
  -- `H[a·S + s]`: a segment of `s` starting at `a`, its entry on, and all after.
  let mut Bk : Array Float := Array.replicate (T * S) NEG_INF
  let mut H : Array Float := Array.replicate ((T + 1) * S) NEG_INF
  for k in [0:T] do
    let b := T - 1 - k
    for s in [0:S] do
      let v :=
        if b == T - 1 then ZERO
        else Id.run do
          let mut st := (NEG_INF, ZERO)
          for s2 in [0:S] do
            if s2 != s then
              st := lseStep st (nats (d.transAt s s2 (b + 1)) + H[(b + 1) * S + s2]!)
          return lseDone st
      Bk := Bk.set! (b * S + s) v
    for s in [0:S] do
      let ent := nats (d.entryAt s b)
      let mut st := (NEG_INF, ZERO)
      if ent != NEG_INF then
        for i in [0:min d.maxD (T - b)] do
          let dd := i + 1
          let e := b + dd - 1
          let tail := Bk[e * S + s]!
          if tail != NEG_INF then
            st := lseStep st (ent + run C K s b e + nats (d.durAt s dd e) + tail)
      H := H.set! (b * S + s) (lseDone st)
  -- Each segment's posterior onto its minutes, by difference arrays.
  let mut D : Array Float := Array.replicate ((T + 1) * S) ZERO
  for b in [0:T] do
    for s in [0:S] do
      let tail := Bk[b * S + s]!
      if tail == NEG_INF then continue
      for i in [0:min d.maxD (b + 1)] do
        let dd := i + 1
        let a := b + 1 - dd
        let x := St[a * S + s]!
        if x == NEG_INF then continue
        let w := x + run C K s a b + nats (d.durAt s dd b) + tail - Z
        if w > NEGLIGIBLE then
          let p := Float.exp w
          D := D.set! (a * S + s) (D[a * S + s]! + p)
          D := D.set! ((b + 1) * S + s) (D[(b + 1) * S + s]! - p)
  let mut M : Array Float := Array.replicate (T * S) ZERO
  let mut acc : Array Float := Array.replicate S ZERO
  for t in [0:T] do
    for s in [0:S] do
      acc := acc.set! s (acc[s]! + D[t * S + s]!)
      M := M.set! (t * S + s) acc[s]!
  return M

end Verified.Hsmm.Posterior
