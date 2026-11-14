import Verified.Eval.GroundTruth
import Verified.Eval.Journeys
/-!
# Three-way truth check

A blessed snapshot conflates rows confirmed true, rows known wrong and rows
never checked, so fixing a known error trips it like a regression. This module
gives each ground-truth row one of five verdicts from its cell (the truth), its
status, its provenance (`isEnforceable`) and the live comparison:

* `verified`: enforceable `correct` row, pipeline matches. Locked.
* `regressed`: enforceable `correct` row, pipeline no longer matches.
* `known-error`: enforceable `wrong` row, pipeline still deviates. Counted
  debt, not a failure.
* `cleared`: enforceable `wrong` row, pipeline now matches.
* `unverified`: no enforceable truth.

`Live.mode` stays a `String`: parsed to `Option Mode`, an unrecognised mode would
become "no live state", a different verdict for a `wrong` row. The route
pattern is explicit walking; an alight of only whitespace is "no route" and
falls to the bare-line branch (a narrative typo).
-/

namespace Verified.Eval.TruthCheck

open Verified.Eval.GroundTruth
open Verified.Eval.Journeys (canonicalMode)

/-! ## Shapes -/

inductive Verdict where
  | verified | regressed | knownError | cleared | unverified
  deriving BEq, Repr, Inhabited

def Verdict.toString : Verdict → String
  | .verified => "verified" | .regressed => "regressed"
  | .knownError => "known-error" | .cleared => "cleared"
  | .unverified => "unverified"

/-- The live pipeline's output for one window, in the truth cell's comparison
form. Same field set as `Truth`, except the mode (see the header). -/
structure Live where
  mode : String
  place : Option String := none
  wayName : Option String := none
  /-- Every road the leg was on; the label names the three longest. -/
  roads : Array String := #[]
  placeQualifier : Option String := none
  trainFrom : Option String := none
  trainTo : Option String := none
  lineName : Option String := none
  deriving BEq, Repr, Inhabited

/-- One drawn state leg, as the replay hands it over. -/
structure StateWindow where
  startTs : Int
  endTs : Int
  mode : String
  place : Option String := none
  wayName : Option String := none
  roads : Array String := #[]
  deriving BEq, Repr, Inhabited

/-! ## String helpers -/

/-- ASCII + Latin-1 lowercase, so a truth cell shouting "CAFÉ" still matches;
above U+00FF no corpus row reaches. -/
private def lowerChar (c : Char) : Char :=
  if c.isUpper then c.toLower
  else if c.val ≥ 0xC0 && c.val ≤ 0xDE && c.val != 0xD7 then
    Char.ofNat (c.val.toNat + 0x20)
  else c

/-- `s.trim().toLowerCase()`. -/
def norm (s : String) : String :=
  String.ofList (s.trimAscii.toString.toList.map lowerChar)

def normOpt : Option String → Option String
  | none => none
  | some s => some (norm s)

/-- `w || null` — JS treats the empty string as absent. -/
private def nonEmpty (s : String) : Option String :=
  if s.isEmpty then none else some s

/-- `/^(.+?)\s+→\s+([^·]+?)(?:\s*·\s*(.+))?$/`: a transit label's
`From → To · Line` as `(from, to, line?)`. The arrow needs whitespace either
side and something before it, so a "→" inside a name does not split it. -/
def splitTransitRoute (s : String) : Option (String × String × Option String) := Id.run do
  let cs := s.toList
  let n := cs.length
  let wsAt := fun (k : Nat) => (cs[k]?.map Char.isWhitespace).getD false
  for i in [0:n] do
    if cs[i]? != some '→' then continue
    -- `\s+` before, and `.+?` needs ≥1 char ahead of that whitespace run.
    if i == 0 || !wsAt (i-1) then continue
    let mut wsStart := i
    while wsStart > 0 && wsAt (wsStart-1) do
      wsStart := wsStart - 1
    if wsStart == 0 then continue
    -- `\s+` after (off the end reads as not whitespace).
    if !wsAt (i+1) then continue
    let mut r := i + 1
    while wsAt r do
      r := r + 1
    let tail := cs.drop r
    let from_ := String.ofList (cs.take wsStart) |>.trimAscii.toString
    match tail.findIdx? (· == '·') with
    | none =>
      let to_ := String.ofList tail |>.trimAscii.toString
      if to_.isEmpty then continue
      return some (from_, to_, none)
    | some p =>
      let to_ := String.ofList (tail.take p) |>.trimAscii.toString
      let lineRaw := String.ofList (tail.drop (p + 1))
      -- `(.+)` needs ≥1 character after the `·`; with none the whole pattern
      -- fails, because `[^·]+?` cannot cross the `·` to reach `$`.
      if to_.isEmpty || lineRaw.isEmpty then continue
      return some (from_, to_, some lineRaw.trimAscii.toString)
  return none

/-! ## Rendering the live side -/

/-- Render a live pipeline state in the truth cells' shapes, so one comparator
serves both: stationary/sleeping → `@ Place (qualifier)`; walking/driving/cycling
→ `on Way`; train/bus → `From → To · Line` or a bare line or road name, compared
on board/alight when present. -/
def parsePipelineState : Option StateWindow → Option Live
  | none => none
  | some st =>
    let m := st.mode
    if m == "train" || m == "bus" then
      let w := (st.wayName.getD "").trimAscii.toString
      match splitTransitRoute w with
      | some (f, t, line) =>
        some { mode := m, trainFrom := some f, trainTo := some t, lineName := line }
      | none =>
        if m == "train" then
          -- Bare line name ("Circle Line") — no board/alight available.
          some { mode := m, lineName := nonEmpty w }
        else
          -- A routeless bus label is road names ("Fifth Way, Edgware Road").
          some { mode := m, wayName := nonEmpty w }
    else match st.place with
    | some p =>
      let (body, qual) := splitTrailingParen p.trimAscii.toString
      some { mode := m, place := some body, placeQualifier := qual }
    | none =>
      some { mode := m, wayName := st.wayName.map (·.trimAscii.toString), roads := st.roads }

/-! ## The comparator -/

/-- Does the live way label carry the road the truth names? A live `wayName` is
a display label of up to three roads joined by ", " (`composeWayName`), so this
asks membership, not equality: equality failed a confirmed walk whose label
added a second road. A road the leg never touched still finds no component. -/
def wayNameCovers (truthWay : String) (liveWay : Option String) : Bool :=
  match liveWay with
  | none => false
  | some lw => (lw.splitOn ",").any (fun part => norm part == norm truthWay)

/-- What separates a truth place's alternative names. -/
def PLACE_ALTERNATIVES : String := " / "

/-- Does the live state match the truth cell? Asymmetric: the truth asserts only
what it names (plain "walking" is satisfied by "walking on X", a train without
`· Line` by any line), and everything it names must hold. The trailing
`(qualifier)` is ignored, and ` / ` separates alternative names for one place.
A null truth or an absent live state never matches. -/
def truthMatches : Option Truth → Option Live → Bool
  | none, _ => false
  | _, none => false
  | some t, some l => Id.run do
    if canonicalMode t.mode != canonicalMode' l.mode then return false
    if t.mode == .train || t.mode == .bus then
      -- A station may have alternative names (` / `), like a place. The live
      -- label's own "(qualifier)" is dropped, as the narrative parser drops
      -- the truth's.
      let stationIs := fun (truthName live : String) =>
        let liveBody := (splitTrailingParen live.trimAscii.toString).1
        (truthName.splitOn PLACE_ALTERNATIVES).any fun alt => norm alt == norm liveBody
      match t.trainFrom, t.trainTo with
      | some tf, some tt =>
        match l.trainFrom, l.trainTo with
        | some lf, some lt => if !stationIs tf lf || !stationIs tt lt then return false
        | _, _ => return false
      | _, _ => pure ()
      -- Line only discriminates when both sides name one — a missing line is a
      -- partial attribution, not a contradiction.
      match t.lineName, l.lineName with
      | some tl, some ll => if norm tl != norm ll then return false
      | _, _ => pure ()
      -- A truth-asserted road for a bus ("bus on Piccadilly") must hold.
      match t.wayName with
      | some tw => if !wayNameCovers tw l.wayName then return false
      | none => pure ()
      return true
    -- A truth-asserted place must match; a truth-asserted way must be a road
    -- the leg was on — in the label, or among the roads the label had no room
    -- for; a truth asserting neither is a mode-only claim.
    match t.place with
    | some tp => return (tp.splitOn PLACE_ALTERNATIVES).any fun alt => normOpt (some alt) == normOpt l.place
    | none =>
      match t.wayName with
      | some tw => return wayNameCovers tw l.wayName || l.roads.any (fun r => norm r == norm tw)
      | none => return true
where
  /-- The live side's mode is a raw string; fold `sleeping` the same way. -/
  canonicalMode' (m : String) : String := if m == "sleeping" then "stationary" else m

/-- The verdict for one row, given whether the live output matches its cell. -/
def rowVerdict (status : Status) (provenance : Provenance) (matchesTruth : Bool) : Verdict :=
  if !(((status == .correct) || (status == .wrong)) && trusted provenance) then .unverified
  else if status == .correct then (if matchesTruth then .verified else .regressed)
  -- `wrong`: a known deviation from the truth in the cell — matching the truth
  -- means it got fixed.
  else (if matchesTruth then .cleared else .knownError)

/-! ## Day classification -/

/-- One audit row with its window already resolved to unix seconds. -/
structure TRow where
  startTs : Int
  endTs : Int
  status : Status
  provenance : Provenance
  truth : Option Truth
  deriving BEq, Repr, Inhabited

/-- The state covering a row's window, sampled at its midpoint: a row claims
what was happening then, and a leg clipping the window's edge did not answer
it. -/
def stateIdxAt (states : Array StateWindow) (startTs endTs : Int) : Option Nat :=
  -- `(startTs + endTs) / 2` in JS is a float midpoint; an odd sum lands on .5.
  -- Doubling the bounds instead keeps it exact and orders identically.
  let mid2 := startTs + endTs
  states.findIdx? (fun s => 2 * s.startTs ≤ mid2 && mid2 < 2 * s.endTs)

def stateAt (states : Array StateWindow) (startTs endTs : Int) : Option StateWindow :=
  (stateIdxAt states startTs endTs).bind (states[·]?)

structure DayResult where
  verdicts : Array Verdict
  verified : Nat
  regressed : Nat
  knownError : Nat
  cleared : Nat
  unverified : Nat
  /-- True iff any enforceable `correct` row no longer matches — the only
  verdict class that should fail a check. -/
  hasRegression : Bool
  /-- Which state covered each row, positionally, or `-1`: a regressed row
  names what broke, not what the pipeline said. Computed here so a debug view
  cannot disagree with the verdict it explains. -/
  covering : Array Int
  deriving Inhabited

/-- Classify every row of a day against the drawn state legs. -/
def classifyDay (rows : Array TRow) (states : Array StateWindow) : DayResult :=
  let covering := rows.map fun r =>
    match stateIdxAt states r.startTs r.endTs with
    | some i => (i : Int)
    | none => -1
  let verdicts := rows.map fun r =>
    rowVerdict r.status r.provenance
      (truthMatches r.truth (parsePipelineState (stateAt states r.startTs r.endTs)))
  let count (v : Verdict) := (verdicts.filter (· == v)).size
  { verdicts, covering,
    verified := count .verified, regressed := count .regressed,
    knownError := count .knownError, cleared := count .cleared,
    unverified := count .unverified,
    hasRegression := verdicts.any (· == .regressed) }


/-! ## Witnesses

⚠ Synthetic names only: the shapes are drawn from the real corpus, but this
file is tracked and the repo is public.

Two branches no corpus row reaches live only here: `splitTransitRoute`'s
empty-`from` guard, and `nonEmpty` on an empty transit label (a train cell with
a line but no route, of which there are none).
-/

section Witnesses

open Verified.Eval.GroundTruth

private def tw (m : Mode) (way : Option String := none) (pl : Option String := none)
    (q : Option String := none) (f t l : Option String := none) : Truth :=
  { mode := m, wayName := way, place := pl, placeQualifier := q,
    trainFrom := f, trainTo := t, lineName := l }

private def st (s e : Int) (m : String) (pl : Option String := none)
    (way : Option String := none) (roads : Array String := #[]) : StateWindow :=
  { startTs := s, endTs := e, mode := m, place := pl, wayName := way, roads }

-- splitTransitRoute: the arrow needs whitespace on both sides.
#guard splitTransitRoute "Alpha → Beta" == some ("Alpha", "Beta", none)
#guard splitTransitRoute "Alpha → Beta · Red Line" == some ("Alpha", "Beta", some "Red Line")
#guard splitTransitRoute "Alpha→Beta" == none
#guard splitTransitRoute "Alpha→ Beta" == none
#guard splitTransitRoute "Alpha →Beta" == none
-- Multi-word names survive; only the first qualifying arrow splits.
#guard splitTransitRoute "Alpha Cross → Beta Park" == some ("Alpha Cross", "Beta Park", none)
-- The line is everything after the first separator — the alight cannot hold one.
#guard splitTransitRoute "Alpha → Beta · Red · extra" == some ("Alpha", "Beta", some "Red · extra")
-- A trailing separator with nothing after it fails the whole pattern: `(.+)`
-- needs a character and `[^·]+?` cannot cross the `·` to reach the end.
#guard splitTransitRoute "Alpha → Beta ·" == none
-- Corpus-unreachable: an empty board station. The guard exists so the walk
-- matches the regex; no narrative produces it, and the verdict would agree.
#guard splitTransitRoute " → Beta" == none
#guard splitTransitRoute "Alpha →  · Red" == none
#guard splitTransitRoute "" == none
#guard splitTransitRoute "no arrow here" == none

-- parsePipelineState: one renderer per live shape.
#guard parsePipelineState none == none
#guard (parsePipelineState (some (st 0 9 "stationary" (pl := some "Cafe Delta")))).map (·.place)
    == some (some "Cafe Delta")
#guard (parsePipelineState (some (st 0 9 "stationary" (pl := some "Cafe Delta (cafe)")))).map (·.placeQualifier)
    == some (some "cafe")
#guard (parsePipelineState (some (st 0 9 "stationary" (pl := some "Cafe Delta (cafe)")))).map (·.place)
    == some (some "Cafe Delta")
-- A parenthetical with no space before it is part of the name.
#guard (parsePipelineState (some (st 0 9 "stationary" (pl := some "Mine(2)")))).map (·.place)
    == some (some "Mine(2)")
#guard (parsePipelineState (some (st 0 9 "walking" (way := some "Alpha Road")))).map (·.wayName)
    == some (some "Alpha Road")
#guard (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red")))).map (·.trainFrom)
    == some (some "Alpha")
#guard (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red")))).map (·.lineName)
    == some (some "Red")
-- Train with no route reads the label as a bare line …
#guard (parsePipelineState (some (st 0 9 "train" (way := some "Red Line")))).map (·.lineName)
    == some (some "Red Line")
#guard (parsePipelineState (some (st 0 9 "train" (way := some "Red Line")))).map (·.wayName)
    == some none
-- … while a bus with no route reads it as road names. The two fall back
-- differently and swapping them is invisible in every shape but a bus row that
-- asserts a road, of which the corpus has exactly one.
#guard (parsePipelineState (some (st 0 9 "bus" (way := some "Alpha Road, Beta Street")))).map (·.wayName)
    == some (some "Alpha Road, Beta Street")
#guard (parsePipelineState (some (st 0 9 "bus" (way := some "Alpha Road, Beta Street")))).map (·.lineName)
    == some none
-- Corpus-unreachable: an empty label is absent, not an empty assertion.
#guard (parsePipelineState (some (st 0 9 "train" (way := some "")))).map (·.lineName) == some none
#guard (parsePipelineState (some (st 0 9 "bus" (way := some "")))).map (·.wayName) == some none
-- An unknown mode is carried through as a string rather than dropped.
#guard (parsePipelineState (some (st 0 9 "teleporting"))).map (·.mode) == some "teleporting"

-- wayNameCovers: membership, not equality, and case-folded.
#guard wayNameCovers "Alpha Road" (some "Alpha Road, Beta Street")
#guard wayNameCovers "Beta Street" (some "Alpha Road, Beta Street")
#guard wayNameCovers "alpha road" (some "ALPHA ROAD")
#guard !wayNameCovers "Gamma Lane" (some "Alpha Road, Beta Street")
#guard !wayNameCovers "Alpha" (some "Alpha Road")
#guard !wayNameCovers "Alpha Road" none

-- truthMatches: the asymmetry. A truth asserts only what it names.
#guard truthMatches (some (tw .walking)) (parsePipelineState (some (st 0 9 "walking" (way := some "Alpha Road"))))
#guard truthMatches (some (tw .walking (way := some "Alpha Road")))
    (parsePipelineState (some (st 0 9 "walking" (way := some "Alpha Road, Beta Street"))))
#guard !truthMatches (some (tw .walking (way := some "Gamma Lane")))
    (parsePipelineState (some (st 0 9 "walking" (way := some "Alpha Road, Beta Street"))))
-- A road the leg was on but the label had no room for holds the row.
#guard truthMatches (some (tw .walking (way := some "Gamma Lane")))
    (parsePipelineState (some (st 0 9 "walking" (way := some "Alpha Road, Beta Street")
      (roads := #["Alpha Road", "Beta Street", "Gamma Lane"]))))
-- The qualifier is ignored on both sides — right place, wrong amenity still matches.
#guard truthMatches (some (tw .stationary (pl := some "Cafe Delta") (q := some "restaurant")))
    (parsePipelineState (some (st 0 9 "stationary" (pl := some "Cafe Delta (cafe)"))))
#guard !truthMatches (some (tw .stationary (pl := some "Cafe Delta")))
    (parsePipelineState (some (st 0 9 "stationary" (pl := some "Cafe Epsilon"))))
-- One place under several names: any one of them matches, and nothing else does.
#guard truthMatches (some (tw .stationary (pl := some "Station Alpha / Alpha International")))
    (parsePipelineState (some (st 0 9 "stationary" (pl := some "Alpha International"))))
#guard truthMatches (some (tw .stationary (pl := some "Station Alpha / Alpha International")))
    (parsePipelineState (some (st 0 9 "stationary" (pl := some "Station Alpha"))))
#guard !truthMatches (some (tw .stationary (pl := some "Station Alpha / Alpha International")))
    (parsePipelineState (some (st 0 9 "stationary" (pl := some "Alpha Cross"))))
-- sleeping and stationary are one class.
#guard truthMatches (some (tw .sleeping (pl := some "Home"))) (parsePipelineState (some (st 0 9 "stationary" (pl := some "Home"))))
#guard truthMatches (some (tw .stationary (pl := some "Home"))) (parsePipelineState (some (st 0 9 "sleeping" (pl := some "Home"))))
#guard !truthMatches (some (tw .walking)) (parsePipelineState (some (st 0 9 "stationary" (pl := some "Home"))))
-- A route without a line is satisfied by any line; a named line must agree.
#guard truthMatches (some (tw .train (f := some "Alpha") (t := some "Beta")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red"))))
#guard truthMatches (some (tw .train (f := some "Alpha") (t := some "Beta") (l := some "Red")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red"))))
-- A station under two names: the live end matches either; the live end's own
-- "(qualifier)" does not count against it.
#guard truthMatches (some (tw .train (f := some "Alpha Central / Alpha") (t := some "Beta")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta (Metro) · Red"))))
#guard !truthMatches (some (tw .train (f := some "Alpha Central / Alpha") (t := some "Gamma")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta (Metro) · Red"))))
#guard !truthMatches (some (tw .train (f := some "Alpha") (t := some "Beta") (l := some "Blue")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red"))))
-- A truth naming stations against a live bare line has nothing to compare: fail.
#guard !truthMatches (some (tw .train (f := some "Alpha") (t := some "Beta")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Red Line"))))
-- A truth naming only a line matches a live route on that line.
#guard truthMatches (some (tw .train (l := some "Red")))
    (parsePipelineState (some (st 0 9 "train" (way := some "Alpha → Beta · Red"))))
-- A bus truth asserting a road is checked against the road label.
#guard truthMatches (some (tw .bus (way := some "Alpha Road")))
    (parsePipelineState (some (st 0 9 "bus" (way := some "Alpha Road, Beta Street"))))
#guard !truthMatches (some (tw .bus (way := some "Gamma Lane")))
    (parsePipelineState (some (st 0 9 "bus" (way := some "Alpha Road, Beta Street"))))
-- An unparsed cell and an absent state never match.
#guard !truthMatches none (parsePipelineState (some (st 0 9 "walking")))
#guard !truthMatches (some (tw .walking)) none

-- rowVerdict: all five, and the provenance gate.
#guard rowVerdict .correct .user true == .verified
#guard rowVerdict .correct .user false == .regressed
#guard rowVerdict .wrong .corroborated false == .knownError
#guard rowVerdict .wrong .corroborated true == .cleared
#guard rowVerdict .correct .inferred false == .unverified
#guard rowVerdict .correct .unspecified false == .unverified
#guard rowVerdict .«partial» .user false == .unverified
#guard rowVerdict .unclear .corroborated true == .unverified
#guard rowVerdict .correct .derived true == .verified

-- stateAt: the midpoint, and an odd window lands between two integers.
#guard (stateAt #[st 0 100 "walking"] 10 20).isSome
#guard (stateAt #[st 0 100 "walking"] 10 21).isSome
-- A leg that ends exactly at the midpoint does not cover it; one that starts
-- there does. `[start, end)`, and the half-open end is what a nine-second
-- shortfall at a window's tail turns on.
#guard (stateAt #[st 0 15 "walking"] 10 20) == none
#guard (stateAt #[st 15 40 "walking"] 10 20).isSome
-- An odd sum: the midpoint is 15.5, so a leg ending at 15 misses and one
-- ending at 16 covers. Integer halving would round the two together.
#guard (stateAt #[st 0 15 "walking"] 10 21) == none
#guard (stateAt #[st 0 16 "walking"] 10 21).isSome
#guard (stateAt #[st 15 40 "walking"] 10 21).isSome
-- Overlapping legs: the first match wins, as `Array.find?` and `Array.prototype.find` both do.
#guard (stateAt #[st 0 100 "walking", st 0 100 "train"] 10 20).map (·.mode) == some "walking"
#guard (stateAt #[] 10 20) == none

-- classifyDay: the tally, and `hasRegression` fires on exactly one class.
private def demoRows : Array TRow := #[
  { startTs := 0, endTs := 10, status := .correct, provenance := .user,
    truth := some (tw .walking (way := some "Alpha Road")) },
  { startTs := 20, endTs := 30, status := .correct, provenance := .user,
    truth := some (tw .walking (way := some "Gamma Lane")) },
  { startTs := 40, endTs := 50, status := .wrong, provenance := .corroborated,
    truth := some (tw .stationary (pl := some "Cafe Delta")) },
  { startTs := 60, endTs := 70, status := .wrong, provenance := .corroborated,
    truth := some (tw .stationary (pl := some "Cafe Epsilon")) },
  { startTs := 80, endTs := 90, status := .correct, provenance := .inferred,
    truth := some (tw .walking) }]

private def demoStates : Array StateWindow := #[
  st 0 10 "walking" (way := some "Alpha Road, Beta Street"),
  st 20 30 "walking" (way := some "Alpha Road"),
  st 40 50 "stationary" (pl := some "Cafe Delta (cafe)"),
  st 60 70 "stationary" (pl := some "Cafe Zeta"),
  st 80 90 "walking"]

#guard (classifyDay demoRows demoStates).verdicts
    == #[.verified, .regressed, .cleared, .knownError, .unverified]
#guard (classifyDay demoRows demoStates).covering == #[0, 1, 2, 3, 4]
#guard (classifyDay demoRows #[]).covering == #[-1, -1, -1, -1, -1]
-- The covering index and the verdict come from one lookup: a row covered by
-- nothing can never be `verified`.
#guard (classifyDay demoRows (demoStates.eraseIdx! 0)).covering == #[-1, 0, 1, 2, 3]
#guard (classifyDay demoRows (demoStates.eraseIdx! 0)).verdicts[0]! == .regressed
#guard (classifyDay demoRows demoStates).verified == 1
#guard (classifyDay demoRows demoStates).regressed == 1
#guard (classifyDay demoRows demoStates).cleared == 1
#guard (classifyDay demoRows demoStates).knownError == 1
#guard (classifyDay demoRows demoStates).unverified == 1
#guard (classifyDay demoRows demoStates).hasRegression
-- Drop the one regressed row and the flag clears — a known error is debt, not
-- a failure, and it must not be able to fail the gate on its own.
#guard !(classifyDay (demoRows.eraseIdx! 1) demoStates).hasRegression
#guard (classifyDay (demoRows.eraseIdx! 1) demoStates).knownError == 1
-- No states at all: every enforceable row regresses or stays debt, none pass.
#guard (classifyDay demoRows #[]).verified == 0
#guard (classifyDay demoRows #[]).regressed == 2
#guard (classifyDay demoRows #[]).knownError == 2
#guard (classifyDay #[] demoStates).verdicts == #[]
#guard !(classifyDay #[] demoStates).hasRegression

end Witnesses

end Verified.Eval.TruthCheck
