import Verified.Hsmm.Entry
import Verified.Hsmm.TrainGenerator
import Verified.Hsmm.TrainHopDuration
import Verified.Hsmm.SegmentEvidence
import Verified.Hsmm.Transitions
import Verified.Hsmm.Quantize
/-!
# Model assembly — factor composition + quantised tensor build (port of `buildHsmmModel` + `quantizeModel`)

The last structural layer before `Main.lean`: compose the per-cell scoring
callbacks exactly as `buildHsmmModel` sums its ported factors, then quantise them
into the integer tensors the verified trellis reads. Together with
`EmissionFull.emissionLogProbFull` (the composed emission) this is the full
`{emission, entry, initial, duration, transition}` model surface.

`buildHsmmModel`'s composition (decode.ts):
* `emission   = base + geometric + routeRail + lineProximity`  — `EmissionFull`.
* `entry      = entryPrior + trainGen.entry`                   — `entryLogProbFull`.
* `initial    = 0`                                              — `Entry.initialStateLogProb`.
* `duration   = trainHopDuration (+ segmentEvidence)`          — `durationLogProbFull`.
* `transition = transition (+ chainContext, −∞ short-circuit)` — `transitionLogProbFull`.

The composition is `a + b` (and one `−∞` short-circuit / two flag gates), so what
the `#guard`s pin is the WIRING — the right summands, the right gate, the
short-circuit — over sub-values already pinned bit-for-bit in their own modules.
Segment-evidence's `Window` and chain-context's per-transition penalty stay
caller-resolved, exactly as those modules declare (the geometry they need is the
parity boundary); everything the callbacks themselves do is here.

`quantizeModel`'s sparse/class-factorised/RLE duration export exists ONLY to
shrink the JSON crossing the TS→Lean process boundary. Assembling the tensors
in-process removes that boundary, so the Lean build is the dense map of
`quantize` over the grid — `buildCellTensor` / `buildVector` — with no export
machinery. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Assembly

open Verified.Hsmm.FloatScore (negInf)
open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.Duration (GammaFit)
open Verified.Hsmm.Quantize (quantize)

/-! ## Factor composition (the `buildHsmmModel` sums) -/

/-- `entryLogProb = baseEntryLogProb(s,obs) + trainGen.entry(s,obs)`. The
    hour-profile / visit-weight resolution and the `(covered, lineValid)` verdict
    are caller-side (the maps and the candidate generator); this is the sum. -/
def entryLogProbFull (s : State) (hourLocal : Nat) (useHourProfiles : Bool)
    (profile : Option (Array Float)) (nPlaces : Nat) (visitWeight : Option Float)
    (covered lineValid : Bool) : Float :=
  Entry.entryLogProb s hourLocal useHourProfiles profile nPlaces visitWeight
    + TrainGenerator.trainEntryPrior s covered lineValid

/-- `initialLogProb`: uniform `0` today. -/
def initialLogProbFull (s : State) : Float := Entry.initialStateLogProb s

/-- `durationLogProb = durationPrior(s,d,e) (+ segmentEvidence(s,d,e))`. The
    train-hop relaxation's `covered`/`fit`/floors arrive resolved; the segment
    evidence resolves its own `Window` from the observation tensor
    (`segmentEvidenceAt`), so nothing about scoring is caller-stubbed. `segEvidenceOn`
    gates the second summand (the C4.2 flag). `pref` is `stepPrefix obs` (built once). -/
def durationLogProbFull (obs : Array ObsRow) (pref : Array Float)
    (s : State) (d segEnd : Nat) (covered : Bool)
    (fit : GammaFit) (minForMode trainMin : Float) (segEvidenceOn : Bool) : Float :=
  TrainHopDuration.trainHopDurationLogProb s d.toFloat covered fit minForMode trainMin
    + (if segEvidenceOn then SegmentEvidence.segmentEvidenceAt obs pref s.mode d segEnd else 0.0)

/-- `transitionLogProb = transition(from,to) (+ chainContext)`, with the
    `t === −∞ ⇒ −∞` short-circuit (a hard-zero transition stays hard-zero; the
    chain penalty is never added to it). The base transition carries the
    station-graph `placeNear` hard-zero (served `buildTransitionMatrix`). `chainOn`
    gates the C4.2 flag; `chainVal` is the caller-resolved per-transition penalty. -/
def transitionLogProbFull (placeNear : Int → String → Bool) (states : List State) (selfLoop : Float)
    (src dst : State) (chainOn : Bool) (chainVal : Float) : Float :=
  let t := Transitions.transitionLogProbP placeNear states selfLoop src dst
  if !chainOn then t
  else if t == negInf then t
  else t + chainVal

/-! ## Quantised tensor assembly (the dense in-process `quantizeModel`) -/

/-- `emit[t][s]` / `entry[t][s]` / `trans[a][b]` / `dur[s][d]` all share one shape:
    quantise a per-cell scorer over an `rows × cols` grid. `f i j` is the composed
    float score for cell `(i, j)`; `−∞ ↦ none` (the packed decoder's hard zero). -/
def buildCellTensor (rows cols : Nat) (f : Nat → Nat → Float) : Array (Array (Option Float)) :=
  (Array.range rows).map (fun i => (Array.range cols).map (fun j => quantize (f i j)))

/-- `init[s]`: quantise a per-state scorer over the state vector. -/
def buildVector (n : Nat) (f : Nat → Float) : Array (Option Float) :=
  (Array.range n).map (fun i => quantize (f i))

-- Parity with `buildHsmmModel`'s composition (sub-values are the sibling modules'
-- own pinned constants; these guards pin the wiring).
private def approxF (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def stt (m : Mode) (pid : Option Int) (ln : Option String) : State := ⟨m, pid, ln⟩
private def prof : Array Float := ((Array.range 24).map (fun i => (i.toFloat + 1) / 300)).set! 3 0.0005
private def gf (a b : Float) : GammaFit := ⟨a, b, 10⟩

-- entry = entryPrior + trainGen.entry
#guard entryLogProbFull (stt .stationary (some 5) none) 14 true (some prof) 2 (some 0.3) false false
  == -0.32850406697203594                              -- stationary: entryPrior only, trainGen 0
#guard entryLogProbFull (stt .train none (some "Jubilee")) 14 true (some prof) 2 (some 0.3) true true
  == 3                                                 -- train: entryPrior 0, generator boost
#guard entryLogProbFull (stt .train none (some "Metropolitan")) 14 true (some prof) 2 (some 0.3) true false
  == -8                                                -- train: covered but line invalid

-- initial = 0
#guard initialLogProbFull (stt .stationary (some 5) none) == 0

-- duration = trainHopDuration (+ segmentEvidence). Fixture: bracketed blackout
-- [1..5] (890 m, 500 steps), the same one SegmentEvidence pins its window on.
private def dsev (i : Nat) (prev next : Option Fix) : ObsRow :=
  { ts := 1000 + (i : Int) * 60, gps := none, hr := none, cadence := some 100,
    hourLocal := 0, dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none,
    reacquireAgeMin := none, prevGpsFix := prev, nextGpsFix := next }
private def dObs : Array ObsRow := #[
  dsev 0 none none, dsev 1 (some ⟨1060, 51.5, -0.1⟩) none, dsev 2 none none,
  dsev 3 none none, dsev 4 none none, dsev 5 none (some ⟨1360, 51.508, -0.1⟩)]
private def dPref : Array Float := SegmentEvidence.stepPrefix dObs
#guard durationLogProbFull dObs dPref (stt .train none (some "Jubilee")) 1 1 true (gf 4 0.1333) 2 2 false
  == 0                                                 -- hop relaxation, segEv off
#guard durationLogProbFull dObs dPref (stt .train none (some "Jubilee")) 1 1 false (gf 4 0.1333) 2 2 false
  == -10                                               -- uncovered → floor, segEv off
#guard approxF (durationLogProbFull dObs dPref (stt .train none (some "Jubilee")) 5 5 false (gf 4 0.13333333333333333) 2 2 true)
  (-6.455452978444667)                                 -- logDur(5) -5.6897… + segEv(train,5,5) -0.7657…

-- transition = transition (+ chainContext), with the −∞ short-circuit
private def space : List State :=
  [stt .stationary (some 5) none, stt .stationary (some 7) none, stt .walking none none,
   stt .train none (some "Central"), stt .driving none none]
private def sl : Float := Transitions.defaultSelfLoop
private def allNear : Int → String → Bool := fun _ _ => true
#guard transitionLogProbFull allNear space sl space[0]! space[2]! false 0 == -4.0943445622220995   -- chain off → base
#guard approxF (transitionLogProbFull allNear space sl space[0]! space[2]! true (-0.05555555555555555))
  (-4.149900117777655)                                  -- base + chain penalty
#guard transitionLogProbFull allNear space sl space[0]! space[1]! true (-0.05555555555555555) == negInf  -- hard-zero short-circuits chain

-- tensor assembly: dense quantise over the grid; −∞ → none.
#guard buildCellTensor 2 2 (fun i j => if i == 1 && j == 1 then negInf else 0.0)
  == #[#[some 0, some 0], #[some 0, none]]
#guard buildVector 3 (fun i => -(i.toFloat)) == #[some 0, some (-1048576), some (-2097152)]

end Verified.Hsmm.Assembly
