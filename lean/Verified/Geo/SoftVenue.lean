import Verified.Geo.VenuePrior
import Verified.FloatConst

/-!
# Which venue a stay was at, from his habits

A stay among several venues is a mixture over them: each candidate weighed by
its distance from the stay, his habits for its kind of place (how often he
goes to one, for how long, at what hour) and its tagged opening hours. The
habits are learned from every visit, each counted fractionally over its
candidates by that same weighing and re-estimated until they settle (EM), so a
dense high street teaches as much as a lone venue does.

* `Habits.of`: the weighing's terms from a `VenuePriors` blob of fractional
  counts, smoothed: the share by a Dirichlet of `ALPHA` pseudo-visits spread
  evenly, each subtype's dwell and hour shrunk toward his overall ones by the
  picker's own pseudo-visit counts.
* `posterior`: each candidate's probability for one visit.
* `learn`: the EM over every visit; its events are the blob's evidence, one
  per candidate and hour, weighted by the posterior.

Measured on the confirmed named stays, held out by day: 87 of 104 against the
ranked picker's 84; the posterior calibrated above one half
(`tests/golden/fits/instruments/venue/em3.py`).

UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.SoftVenue

open Verified.Geo.VenuePrior
  (VenuePriors VenueTypeStats PriorEvent Landmark StayShape DWELL_BUCKETS DWELL_PSEUDO_VISITS
   HOUR_PSEUDO_VISITS priorsOfEvents)

/-- The spread of a visit's position about its venue, metres: the 2-D Gaussian
    fitted on the confirmed stays' true venues (9.5–11 m; 11 held out best of
    9.5, 11 and 14). -/
def SIGMA_M : Float := 11
/-- Pseudo-visits behind the share, spread evenly over the subtypes. -/
def ALPHA : Float := 1
/-- How far a candidate may be: beyond it a venue is not where he sat. -/
def MAX_M : Float := 60
/-- EM rounds: the counts settle well before. -/
def ITERS : Nat := 30
def HOURS : Nat := 24

/-- One candidate venue of a visit. -/
structure Cand where
  name : String
  subtype : String
  distanceM : Float
  /-- The tagged opening hours over the stay, in nats (`hoursScore`); `none`
      for no tag. -/
  hoursNats : Option Float := none
  deriving Inhabited, BEq, Repr

/-- One visit: when, its dwell bucket, its minutes by local hour (an empty list
    says nothing about the hour, and the visit does not train), its
    candidates. -/
structure Visit where
  startUnix : Int
  bucket : Nat
  hours : List (Nat × Float)
  cands : List Cand
  deriving Inhabited, BEq, Repr

/-- The weighing's terms, smoothed, for every subtype the blob knows. -/
structure Habits where
  subs : List (String × VenueTypeStats)
  total : Float
  /-- His overall dwell and hour shapes, which a thin subtype shrinks toward. -/
  dwellAll : List Float
  hourAll : List Float
  deriving Inhabited

private def addLists (a b : List Float) : List Float := (a.zip b).map fun (x, y) => x + y
private def normalise (xs : List Float) : List Float :=
  let s := xs.foldl (· + ·) 0
  if s > 0 then xs.map (· / s) else xs.map fun _ => 1 / Verified.FloatConst.natToFloat xs.length

def Habits.of (p : VenuePriors) : Habits :=
  let dw := fun (st : VenueTypeStats) => st.dwell.map (· + ALPHA / Verified.FloatConst.natToFloat DWELL_BUCKETS)
  let hr := fun (st : VenueTypeStats) => st.hours.map (· + ALPHA / Verified.FloatConst.natToFloat HOURS)
  let zeroD := List.replicate DWELL_BUCKETS 0
  let zeroH := List.replicate HOURS 0
  { subs := p.bySubtype, total := p.totalVisits
    dwellAll := normalise (p.bySubtype.foldl (fun a (_, st) => addLists a (dw st)) zeroD)
    hourAll := normalise (p.bySubtype.foldl (fun a (_, st) => addLists a (hr st)) zeroH) }

/-- `log` of a candidate's weight for a visit, up to the visit's constant. -/
def logWeight (h : Habits) (v : Visit) (c : Cand) : Float :=
  let s := Verified.FloatConst.natToFloat (max h.subs.length 1)
  let st := (h.subs.find? (·.1 == c.subtype)).map (·.2)
  let visits := (st.map (·.visits)).getD 0
  let share := (visits + ALPHA / s) / (h.total + ALPHA)
  let dwellRaw := (st.map (·.dwell)).getD (List.replicate DWELL_BUCKETS 0)
  let hourRaw := (st.map (·.hours)).getD (List.replicate HOURS 0)
  let n := visits + ALPHA
  let dwellP := (dwellRaw.getD v.bucket 0 + ALPHA / Verified.FloatConst.natToFloat DWELL_BUCKETS
      + DWELL_PSEUDO_VISITS * h.dwellAll.getD v.bucket 0) / (n + DWELL_PSEUDO_VISITS)
  let hourP := fun (k : Nat) => (hourRaw.getD k 0 + ALPHA / Verified.FloatConst.natToFloat HOURS
      + HOUR_PSEUDO_VISITS * h.hourAll.getD k 0) / (n + HOUR_PSEUDO_VISITS)
  let mins : Float := v.hours.foldl (fun a (_, m) => a + m) 0
  let hourTerm := if mins > 0 then
      v.hours.foldl (fun a (k, m) => a + m * Float.log (hourP k)) 0 / mins else 0
  let distance := -0.5 * (c.distanceM / SIGMA_M) ^ 2
  distance + Float.log share + Float.log dwellP + hourTerm + c.hoursNats.getD 0

/-- A stay as a visit: its typed venues within `MAX_M` (street furniture is
    nowhere one sits), its minutes by local hour from `(weekday, minute)`
    samples. `none` where a footprint encloses it: that names it, not habits.
    Shared by the picker and the miner, so both weigh the same visit. -/
def visitOf (samples : List (Nat × Nat)) (st : StayShape) (landmarks : List Landmark) : Option Visit :=
  if landmarks.any (·.enclosing) then none else
  let cands := landmarks.filter fun l =>
    Verified.Geo.VenuePrior.VENUE_TYPES.contains l.type
      && !Verified.Geo.VenuePrior.NEVER_DESTINATION_SUBTYPES.contains l.subtype
      && decide (l.distanceM ≤ MAX_M)
  if cands.isEmpty then none else
  let hours := samples.foldl (fun (acc : List (Nat × Float)) (_, mn) =>
    let h := mn / 60
    if acc.any (·.1 == h) then acc.map fun (k, n) => if k == h then (k, n + 1) else (k, n)
    else acc ++ [(h, 1)]) []
  some { startUnix := st.startUnix
         bucket := Verified.Geo.VenuePrior.dwellBucket (Float.ofInt (st.endUnix - st.startUnix))
         hours := hours
         cands := cands.map fun l =>
           { name := l.name, subtype := l.subtype, distanceM := l.distanceM
             hoursNats := Verified.Geo.VenuePrior.hoursScore l.openFraction } }

/-- The candidates a visit is weighed over: within `MAX_M`. -/
def eligible (v : Visit) : List Cand := v.cands.filter fun c => c.distanceM ≤ MAX_M

/-- Each eligible candidate's probability, in `eligible` order. -/
def posterior (h : Habits) (v : Visit) : List (Cand × Float) :=
  let cs := eligible v
  let ls := cs.map (logWeight h v)
  let m := ls.foldl max (-1e300)
  let ws := ls.map fun l => Float.exp (l - m)
  let z := ws.foldl (· + ·) 0
  cs.zip (ws.map (· / z))

/-- The most probable candidate and its probability; a tie keeps the first. -/
def best (h : Habits) (v : Visit) : Option (Cand × Float) :=
  (posterior h v).foldl (fun acc (c, p) =>
    match acc with
    | none => some (c, p)
    | some (_, bp) => if p > bp then some (c, p) else acc) none

private def minutes (v : Visit) : Float := v.hours.foldl (fun (a : Float) (_, m) => a + m) 0

/-- The evidence of one round: per visit, per candidate and hour, the
    candidate's probability times the hour's share of the visit. -/
def eventsOf (h : Habits) (vs : List Visit) : List PriorEvent :=
  vs.flatMap fun v =>
    let mins := minutes v
    (posterior h v).flatMap fun (c, p) =>
      v.hours.filterMap fun (k, m) =>
        if m > 0 then some { subtype := c.subtype, startUnix := v.startUnix, dwell := v.bucket,
                             hour := k, weight := p * m / mins }
        else none

/-- Every subtype among the visits' candidates, first seen first, at no mass:
    the startPriors the share is spread over from the first round. -/
def startPriors (vs : List Visit) : VenuePriors :=
  let subs := vs.foldl (fun acc v => (eligible v).foldl (fun a c =>
    if a.contains c.subtype then a else a ++ [c.subtype]) acc) []
  { bySubtype := subs.map fun s => (s, ⟨0, List.replicate DWELL_BUCKETS 0, List.replicate HOURS 0⟩)
    byCategory := [], totalVisits := 0 }

/-- The EM: habits from every visit, `iters` rounds; the last round's events. -/
def learn (vs : List Visit) (iters : Nat := ITERS) : List PriorEvent := Id.run do
  -- A visit with no candidate or no minute teaches nothing.
  let vs := vs.filter fun v => !(eligible v).isEmpty && minutes v > 0
  let mut h := Habits.of (startPriors vs)
  let mut evs : List PriorEvent := []
  for _ in [0:iters] do
    evs := eventsOf h vs
    h := Habits.of (priorsOfEvents evs)
  return evs

/-! ## Guards -/

private def cafe (d : Float) : Cand := ⟨"Cafe", "cafe", d, none⟩
private def pub (d : Float) : Cand := ⟨"Pub", "pub", d, none⟩
private def visit (cs : List Cand) (hour : Nat := 10) : Visit :=
  { startUnix := 0, bucket := 2, hours := [(hour, 60)], cands := cs }

-- No habits: distance alone decides, and the nearer wins.
#guard ((best (Habits.of (startPriors [visit [cafe 14, pub 5]])) (visit [cafe 14, pub 5])).map (·.1.name)) == some "Pub"
-- A candidate past `MAX_M` is no candidate.
#guard (posterior (Habits.of (startPriors [])) (visit [cafe 61, pub 5])).length == 1
-- Probabilities sum to one.
#guard ((posterior (Habits.of (startPriors [visit [cafe 14, pub 5]])) (visit [cafe 14, pub 5])).foldl
  (fun (a : Float) (_, p) => a + p) 0 - 1).abs < 1e-12
-- Habits learned from many lone café visits name the café on the high street,
-- 14 m against a pub's 5: the stays that were never ambiguous teach the one
-- that is.
private def lone : List Visit := (List.range 20).map fun _ => visit [cafe 4]
#guard ((best (Habits.of (priorsOfEvents (learn (lone ++ [visit [cafe 14, pub 5]])))) (visit [cafe 14, pub 5])).map (·.1.name))
  == some "Cafe"
-- Closed by its tagged hours, a candidate weighs less.
#guard ((best (Habits.of (startPriors [visit [cafe 6, pub 5]])) (visit [cafe 6, { pub 5 with hoursNats := some (-2.5) }])).map (·.1.name))
  == some "Cafe"
-- A visit's weight is spread over its hours, summing to its probability.
#guard ((eventsOf (Habits.of (startPriors [])) [{ visit [cafe 5] with hours := [(9, 30), (10, 30)] }]).map (·.weight))
  == [0.5, 0.5]

end Verified.Geo.SoftVenue
