/-!
# `opening_hours` subset parser (port of `src/geo/opening-hours.ts`)

OSM venue POIs carry an `opening_hours` tag that the venue-plausibility scorer
turns into weighted evidence — never a veto, because OSM hours go stale. The
grammar is a deliberate SUBSET: day ranges/lists, multiple time ranges,
past-midnight wrap, `off`/`closed`, `24/7`, trailing `PH off`. Everything else
parses to `none`, which downstream means **no evidence**, NOT "closed". That
asymmetry is the contract: a wrong "closed" verdict would poison the scorer,
so every unsupported shape must fail closed to silence rather than to a guess.

The TS parser is regex-driven. Lean has no regex, so the three patterns are
hand-rolled here, and their behaviour on MALFORMED input is reproduced exactly
— including two quirks that look like bugs but are load-bearing (the `#guard`s
pin both against V8):

* A bare `"off"` parses to `none`, because the leading-day-spec pattern
  `[A-Za-z]{2}` happily consumes `"of"` as a day token, leaving `"f"`; `"of"`
  is not a day name, so the whole value is rejected. Same for `"closed"`
  (`"cl"`). Only `off`/`closed` *after* a day spec (`"We off"`) closes a day.
* `"PH off"` parses to `none`, not to an all-week-closed spec: a pure
  holiday rule is skipped, so no rule is ever recorded and the value is
  rejected as empty.

The tz boundary stays SHELL: `openFractionDuring` resolves each sampled minute
to a (weekday, minute-of-day) pair through `Intl`, which is exactly the kind of
tz work that does not belong in Lean. {@link openFractionOver} takes those
already-resolved samples, so the arithmetic is here and the calendar is not.

Everything in this module is EXACT (string/`Nat` work); the only `Float` is the
open-fraction division. UNPROVEN; pinned by the `#guard`s against Node/V8
(`lean/experiments/opening-hours-refs.mts`).
-/

namespace Verified.Geo.OpeningHours

/-- An open interval within a day. -/
structure TimeRange where
  /-- Minutes since local midnight, inclusive. -/
  startMin : Nat
  /-- Minutes since local midnight, exclusive. May exceed 1440 when the range
      wraps past midnight (`20:00-02:00` → 1200..1560); the overflow is
      evaluated against the *next* day by `isOpenAt`. -/
  endMin : Nat
  deriving Inhabited, BEq, Repr

/-- Seven entries, index 0 = Monday .. 6 = Sunday (OSM day order). -/
abbrev WeekSpec := List (List TimeRange)

private def MINUTES_PER_DAY : Nat := 24 * 60

/-! ## Character helpers

JS `\s` and `String.trim` cover more than ASCII space; the tags this runs on
are ASCII, and the whitespace actually present is space/tab/newline. -/

private def isWs (c : Char) : Bool := c == ' ' || c == '\t' || c == '\n' || c == '\r'
private def isAlpha (c : Char) : Bool := (c ≥ 'a' && c ≤ 'z') || (c ≥ 'A' && c ≤ 'Z')

private def trimC (l : List Char) : List Char :=
  (l.dropWhile isWs).reverse.dropWhile isWs |>.reverse

private def splitOnChar (sep : Char) : List Char → List (List Char)
  | [] => [[]]
  | c :: cs =>
    let rest := splitOnChar sep cs
    if c == sep then [] :: rest
    else match rest with
         | [] => [[c]]
         | r :: rs => (c :: r) :: rs

private def lowerC (l : List Char) : List Char := l.map Char.toLower

/-- Day names in OSM order, as lowercase character pairs. -/
private def DAY_NAMES : List (Char × Char) :=
  [('m','o'), ('t','u'), ('w','e'), ('t','h'), ('f','r'), ('s','a'), ('s','u')]

/-- Index of a two-letter lowercase day token, or `none` when unrecognised. -/
private def dayIndex (a b : Char) : Option Nat :=
  DAY_NAMES.findIdx? (fun (x, y) => x == a && y == b)

/-! ## `parseDaySpec`

Mirrors the TS: split on `,`, each token matched against
`^([a-z]{2})(?:-([a-z]{2}))?$`. `PH`/`SH` tokens are dropped (holidays are
unknowable here). `none` on any unrecognised token; `some []` when the spec
consisted ONLY of holiday tokens, which the caller skips. -/

/-- Append preserving insertion order and dropping duplicates — the TS uses a
    `Set` and spreads it, which yields insertion order. -/
private def addDay (ds : List Nat) (d : Nat) : List Nat :=
  if ds.contains d then ds else ds ++ [d]

/-- Walk forward through the week from `from` to `to` inclusive, wrapping
    (`Sa-Mo` covers Sa, Su, Mo). Bounded by 7 steps. -/
private def dayRange (ds : List Nat) (from_ to_ : Nat) : List Nat := Id.run do
  let mut acc := ds
  let mut d := from_
  for _ in [0 : 7] do
    acc := addDay acc d
    if d == to_ then break
    d := (d + 1) % 7
  return acc

private def parseDaySpec (spec : List Char) : Option (List Nat) := Id.run do
  let mut days : List Nat := []
  let mut sawHoliday := false
  for token in splitOnChar ',' spec do
    let t := lowerC (trimC token)
    if t == ['p','h'] || t == ['s','h'] then
      sawHoliday := true
      continue
    match t with
    | [a, b] =>
      if !(isAlpha a && isAlpha b) then return none
      match dayIndex a b with
      | none => return none
      | some i => days := addDay days i
    | [a, b, '-', c, d] =>
      if !(isAlpha a && isAlpha b && isAlpha c && isAlpha d) then return none
      match dayIndex a b, dayIndex c d with
      | some i, some j => days := dayRange days i j
      | _, _ => return none
    | _ => return none
  if days.isEmpty then return (if sawHoliday then some [] else none)
  return some days

/-! ## `parseTimeSpec`

Mirrors `^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$` per comma-separated token. -/

/-- One or two digits, returning the value and the remaining characters. -/
private def takeHour : List Char → Option (Nat × List Char)
  | a :: b :: rest =>
    if a.isDigit && b.isDigit then some ((a.toNat - 48) * 10 + (b.toNat - 48), rest)
    else if a.isDigit then some (a.toNat - 48, b :: rest)
    else none
  | [a] => if a.isDigit then some (a.toNat - 48, []) else none
  | [] => none

/-- Exactly two digits. -/
private def takeMinute : List Char → Option (Nat × List Char)
  | a :: b :: rest =>
    if a.isDigit && b.isDigit then some ((a.toNat - 48) * 10 + (b.toNat - 48), rest) else none
  | _ => none

private def parseOneRange (token : List Char) : Option TimeRange := do
  let (h1, r1) ← takeHour (trimC token)
  let r2 ← match r1 with | ':' :: t => some t | _ => none
  let (m1, r3) ← takeMinute r2
  let r4 ← match r3 with | '-' :: t => some t | _ => none
  let (h2, r5) ← takeHour r4
  let r6 ← match r5 with | ':' :: t => some t | _ => none
  let (m2, r7) ← takeMinute r6
  if !r7.isEmpty then none
  else
    let startMin := h1 * 60 + m1
    let endMin0 := h2 * 60 + m2
    if startMin > MINUTES_PER_DAY || endMin0 > MINUTES_PER_DAY then none
    -- A range ending at or before its start wraps past midnight.
    else some ⟨startMin, if endMin0 ≤ startMin then endMin0 + MINUTES_PER_DAY else endMin0⟩

private def parseTimeSpec (spec : List Char) : Option (List TimeRange) := Id.run do
  let mut ranges : List TimeRange := []
  for token in splitOnChar ',' spec do
    match parseOneRange token with
    | none => return none
    | some r => ranges := ranges ++ [r]
  return (if ranges.isEmpty then none else some ranges)

/-! ## `parseOpeningHours` -/

/-- Split a rule into its optional leading day spec and the remainder,
    reproducing `^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)?\s*(.*)$`.

    The day-spec group is greedy, and since the trailing `(.*)` matches
    anything there is never any backtracking — so a plain forward scan that
    keeps the longest run of `XX` tokens joined by `-`/`,` is exact. This is
    the function responsible for the `"off"` quirk: `"of"` is two letters, so
    it becomes the day spec. -/
private def splitLeadingDaySpec (r : List Char) : Option (List Char) × List Char :=
  match r with
  | a :: b :: rest =>
    if !(isAlpha a && isAlpha b) then (none, r)
    else Id.run do
      -- Extend across `\s*[-,]\s*[A-Za-z]{2}` groups for as long as they match.
      let mut spec := [a, b]
      let mut tail := rest
      repeat
        let afterWs := tail.dropWhile isWs
        match afterWs with
        | sep :: more =>
          if sep != '-' && sep != ',' then break
          let more2 := more.dropWhile isWs
          match more2 with
          | x :: y :: rest2 =>
            if !(isAlpha x && isAlpha y) then break
            -- Consume the whole group verbatim, whitespace included.
            spec := spec ++ (tail.take (tail.length - rest2.length))
            tail := rest2
          | _ => break
        | [] => break
      return (some spec, tail.dropWhile isWs)
  | _ => (none, r)

/--
Parse an OSM `opening_hours` value into per-day open ranges, or `none` when it
uses syntax outside the supported subset. Later rules override earlier ones for
the days they mention (OSM semantics: `Mo-Sa 08:00-18:00; We off` closes
Wednesday).
-/
def parseOpeningHours (value : String) : Option WeekSpec := Id.run do
  let trimmed := trimC value.toList
  if trimmed.isEmpty then return none
  if trimmed == "24/7".toList then
    return some (List.replicate 7 [⟨0, MINUTES_PER_DAY⟩])
  let mut week : Array (Option (List TimeRange)) := Array.replicate 7 none
  let mut anyRule := false
  for rule in splitOnChar ';' trimmed do
    let r := trimC rule
    if r.isEmpty then continue
    let (daySpecOpt, rest0) := splitLeadingDaySpec r
    let rest := trimC rest0
    let mut days : List Nat := []
    match daySpecOpt with
    | some ds =>
      match parseDaySpec (ds.filter (fun c => !isWs c)) with
      | none => return none
      | some [] => continue  -- pure PH/SH rule
      | some parsed => days := parsed
    | none => days := [0, 1, 2, 3, 4, 5, 6]
    let lowered := lowerC rest
    let mut ranges : List TimeRange := []
    if lowered == "off".toList || lowered == "closed".toList then
      ranges := []
    else
      match parseTimeSpec rest with
      | none => return none
      | some rs => ranges := rs
    for d in days do
      week := week.set! d (some ranges)
    anyRule := true
  if !anyRule then return none
  return some ((week.map (fun d => d.getD [])).toList)

/-- Is the venue open at `minuteOfDay` on `dayIdx` (0 = Monday)? Checks the
    day's own ranges plus the previous day's past-midnight overflow. -/
def isOpenAt (spec : WeekSpec) (dayIdx minuteOfDay : Nat) : Bool :=
  let today := spec.getD dayIdx []
  if today.any (fun r => decide (minuteOfDay ≥ r.startMin) && decide (minuteOfDay < r.endMin)) then true
  else
    let prev := spec.getD ((dayIdx + 6) % 7) []
    prev.any (fun r =>
      decide (r.endMin > MINUTES_PER_DAY)
      && decide (minuteOfDay + MINUTES_PER_DAY ≥ r.startMin)
      && decide (minuteOfDay + MINUTES_PER_DAY < r.endMin))

/--
Fraction of a stay during which the venue is open, over minute samples the
SHELL resolved to `(dayIdx, minuteOfDay)` in the venue's tz — that resolution
is `Intl` work and stays outside Lean.

The caller samples every 60 s across `[startUnix, endUnix)`, or the single
instant at `startUnix` for a zero-length window, so `samples` is never empty in
practice; an empty list divides 0/0 exactly as the TS would.
-/
def openFractionOver (spec : WeekSpec) (samples : List (Nat × Nat)) : Float :=
  let open_ := samples.foldl (fun acc (d, m) => if isOpenAt spec d m then acc + 1 else acc) 0
  Float.ofNat open_ / Float.ofNat samples.length

/-! ## Parity with Node/V8 (`lean/experiments/opening-hours-refs.mts`)

Every case below is exact — this module does string and `Nat` work only. -/

private def P (s : String) : Option WeekSpec := parseOpeningHours s
private def R (a b : Nat) : TimeRange := ⟨a, b⟩

-- The common real shapes.
#guard P "24/7" == some (List.replicate 7 [R 0 1440])
#guard P "Mo-Fr 09:00-17:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo-Fr 09:00-17:00; Sa 10:00-16:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 600 960], []]
#guard P "Mo-Sa 08:00-18:00; We off"
       == some [[R 480 1080], [R 480 1080], [], [R 480 1080], [R 480 1080], [R 480 1080], []]
#guard P "Mo,We-Fr 08:00-12:00"
       == some [[R 480 720], [], [R 480 720], [R 480 720], [R 480 720], [], []]
-- A wrapping day range walks forward through the week: Sa, Su, Mo.
#guard P "Sa-Mo 10:00-14:00"
       == some [[R 600 840], [], [], [], [], [R 600 840], [R 600 840]]
-- No day spec at all = every day.
#guard P "08:00-20:00" == some (List.replicate 7 [R 480 1200])
#guard P "Mo-Su 11:00-23:00" == some (List.replicate 7 [R 660 1380])
-- A split day keeps both ranges in order.
#guard P "Mo-Fr 08:00-12:00,13:00-17:00"
       == some [[R 480 720, R 780 1020], [R 480 720, R 780 1020], [R 480 720, R 780 1020],
                [R 480 720, R 780 1020], [R 480 720, R 780 1020], [], []]
-- Past-midnight wrap pushes the end past 1440.
#guard P "Tu-Su 20:00-02:00"
       == some [[], [R 1200 1560], [R 1200 1560], [R 1200 1560], [R 1200 1560], [R 1200 1560], [R 1200 1560]]
#guard P "Mo-Fr 09:00-17:00; PH off"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo-Fr 9:00-17:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo-Fr 09:00-17:00; Sa closed"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "mo-fr 09:00-17:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo-Fr  09:00-17:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo - Fr 09:00-17:00"
       == some [[R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [R 540 1020], [], []]
#guard P "Mo,Tu,We 09:00-17:00" == some [[R 540 1020], [R 540 1020], [R 540 1020], [], [], [], []]
-- A later rule overrides an earlier one for the days it mentions.
#guard P "Su 12:00-16:00; Mo-Sa 09:00-20:00"
       == some [[R 540 1200], [R 540 1200], [R 540 1200], [R 540 1200], [R 540 1200], [R 540 1200], [R 720 960]]
-- `off` AFTER a day spec closes those days (contrast the bare `"off"` below).
#guard P "Mo-Fr off; Sa 10:00-12:00" == some [[], [], [], [], [], [R 600 720], []]

/-! ### Outside the subset ⇒ `none` (no evidence, NOT closed) -/

#guard (P "").isNone
#guard (P "   ").isNone
#guard (P "sunrise-sunset").isNone
#guard (P "Mo-Fr 09:00+").isNone
#guard (P "Jan-Mar 09:00-17:00").isNone
#guard (P "week 1-10 09:00-17:00").isNone
#guard (P "Mo-Fr 09:00-17:00; Xx 10:00-12:00").isNone
#guard (P "Mo-Fr 25:00-27:00").isNone
#guard (P "Mo-Fr 09:0-17:00").isNone
#guard (P "Mo-Fr 0900-1700").isNone
#guard (P "Mo-Fr").isNone
#guard (P "Mo-Zz 09:00-17:00").isNone
#guard (P "24/7 open").isNone
-- The two load-bearing quirks: a BARE `off`/`closed` is rejected, because the
-- day-spec pattern eats `"of"`/`"cl"` and neither is a day name.
#guard (P "off").isNone
#guard (P "closed").isNone
-- A pure holiday rule records no rule at all, so the value is empty ⇒ none.
#guard (P "PH off").isNone

/-! ### `isOpenAt` -/

private def spec95 : WeekSpec := (P "Mo-Fr 09:00-17:00").getD []
#guard isOpenAt spec95 0 540 == true    -- exactly open
#guard isOpenAt spec95 0 539 == false   -- one minute early
#guard isOpenAt spec95 0 1019 == true   -- last open minute
#guard isOpenAt spec95 0 1020 == false  -- close is exclusive
#guard isOpenAt spec95 5 600 == false   -- Saturday

-- Past-midnight overflow is credited to the FOLLOWING day.
private def specLate : WeekSpec := (P "Tu-Su 20:00-02:00").getD []
#guard isOpenAt specLate 1 1200 == true   -- Tue 20:00
#guard isOpenAt specLate 1 60 == false    -- Tue 01:00 — Monday is closed
#guard isOpenAt specLate 2 60 == true     -- Wed 01:00 — Tuesday's overflow
#guard isOpenAt specLate 2 120 == false   -- Wed 02:00 — overflow ended
#guard isOpenAt specLate 0 60 == true     -- Mon 01:00 — Sunday's overflow
#guard isOpenAt specLate 1 1199 == false  -- Tue 19:59

private def spec247 : WeekSpec := (P "24/7").getD []
#guard isOpenAt spec247 0 0 == true
#guard isOpenAt spec247 3 720 == true
#guard isOpenAt spec247 6 1439 == true

private def specWed : WeekSpec := (P "Mo-Sa 08:00-18:00; We off").getD []
#guard isOpenAt specWed 2 720 == false
#guard isOpenAt specWed 1 720 == true

private def specLunch : WeekSpec := (P "Mo-Fr 08:00-12:00,13:00-17:00").getD []
#guard isOpenAt specLunch 0 700 == true
#guard isOpenAt specLunch 0 750 == false  -- the lunch gap
#guard isOpenAt specLunch 0 800 == true

/-! ### `openFractionOver` -/

#guard openFractionOver spec95 [(0, 540)] == 1
#guard openFractionOver spec95 [(0, 539)] == 0
#guard openFractionOver spec95 [(0, 1018), (0, 1019), (0, 1020), (0, 1021)] == 0.5
#guard openFractionOver spec247 [(0, 0), (1, 100), (2, 200)] == 1

end Verified.Geo.OpeningHours
