import Verified.Civil
/-!
# Ground-truth narrative parser

`tests/golden/ground-truth/YYYY-MM-DD.md` carries a free-text narrative and then
an `## Audit of …` table. That table is the corpus's only truth signal that is
not self-referential: every other check compares the pipeline against itself or
its blessed output. Each row says what actually happened, and the status says
how the pipeline relates to it. It feeds `routeCorr`, the walk referee's by-name
metric, and `score-decoder`, whose oracle is this narrative.

## Civil time, not instants

`Row` carries the anchored civil fields (`startDay`, `startHh`, `startMm`, and
the same for the end) and the shell resolves them with
`rust/backend/src/timezone.rs`'s `wall_clock_to_unix`: a wall clock in a named
zone needs the tz database, which is data, not logic. Which day and clock time a
row anchors to is decided here and pinned by the `#guard`s.

## No regex

Each pattern is explicit string walking, documented with the regex it
implements; greedy and non-greedy splits differ only on inputs with two
candidate splits, which is where a hand-written matcher drifts. The witnesses
cover every parse shape the real corpus produces.
-/

namespace Verified.Eval.GroundTruth

/-! ## Shapes -/

/-- How the pipeline relates to the row's truth. -/
inductive Status where
  | correct | wrong | «partial» | unclear
  deriving BEq, Repr, Inhabited

/-- How a verdict is KNOWN — the provenance ladder, strongest first.

⚠ `inferred` is read back from the pipeline's own output and is not truth: a
"hair appointment" once wore a `correct` badge that way. `unspecified` is
treated the same, so an unannotated legacy row cannot gate a regression check. -/
inductive Provenance where
  | corroborated | user | derived | inferred | unspecified
  deriving BEq, Repr, Inhabited

inductive Mode where
  | sleeping | stationary | walking | cycling | driving | bus | train | plane
  deriving BEq, Repr, Inhabited

/-- Provenance trustworthy enough to gate a check. -/
def trusted : Provenance → Bool
  | .corroborated | .user | .derived => true
  | .inferred | .unspecified => false

/-- The structured truth cell. `none` fields are "the cell did not assert it". -/
structure Truth where
  mode : Mode
  /-- Focus-place name. `none` for movement modes and train. -/
  place : Option String := none
  /-- OSM way name from "walking on X" — a WEAKER signal than `place`, since
  it is the nearest road rather than a destination. -/
  wayName : Option String := none
  /-- Trailing parenthetical, e.g. "(hotel)" — surfaces the amenity the human
  attributed, which catches a right-name/wrong-amenity match. -/
  placeQualifier : Option String := none
  trainFrom : Option String := none
  trainTo : Option String := none
  /-- Named line or bus route, asserted only with a `· Line` suffix. A trailing
  parenthetical after the alight is COMMENTARY and is not a line assertion. -/
  lineName : Option String := none
  deriving BEq, Repr, Inhabited

/-- One audit row.

The times are civil and already day-anchored; see the module header. -/
structure Row where
  windowText : String
  startDay : String
  startHh : Nat
  startMm : Nat
  endDay : String
  endHh : Nat
  endMm : Nat
  truthText : String
  truth : Option Truth
  status : Status
  provenance : Provenance
  statusText : String
  correctVersionText : Option String
  deriving BEq, Repr, Inhabited

structure Day where
  date : String
  /-- The zone the table's clock times are read in — the caller's, unless the
  file declared its own with a `Times:` line. -/
  tz : String
  rows : Array Row
  deriving Inhabited

/-- A definite verdict backed by trustworthy provenance. Only these may gate a
pipeline-vs-truth check; `partial`/`unclear` and `inferred`/`unspecified` are
advisory. -/
def isEnforceable (r : Row) : Bool :=
  (r.status == .correct || r.status == .wrong) && trusted r.provenance

/-! ## String helpers — each one is a regex the original had -/

/-- `text.replace(/\*+/g, "")`. Emphasis is presentation, not content. -/
def stripStars (s : String) : String :=
  String.ofList (s.toList.filter (· != '*'))

/-- `text.replace(/\{[^}]*\}/g, "")` — drop brace runs.

⚠ `[^}]*` cannot span a `}`, so an unclosed `{` swallows the rest of the string
only if no `}` follows. -/
def stripBraceRuns (s : String) : String := Id.run do
  let mut out : String := ""
  let mut inBrace := false
  for c in s.toList do
    if inBrace then
      if c == '}' then inBrace := false
    else if c == '{' then inBrace := true
    else out := out.push c
  -- An unclosed `{` consumed the tail, matching a regex that never matched.
  if inBrace then
    return (String.ofList (s.toList.takeWhile (· != '{')))
  return out

/-- Is `c` a word character for `\b` purposes (JS: `[A-Za-z0-9_]`)? -/
private def isWordChar (c : Char) : Bool :=
  c.isAlphanum || c == '_'

/-- Index of the first occurrence of `needle` in `hay`, or `none`. -/
def findSub (hay needle : String) : Option Nat := Id.run do
  let h := hay.toList
  let n := needle.toList
  if n.isEmpty then return some 0
  let hs := h.length
  let ns := n.length
  if ns > hs then return none
  for i in [0:hs - ns + 1] do
    if (h.drop i).take ns == n then return some i
  return none

/-- Split off a trailing ` (qualifier)` — the `(?:\s+\(([^)]+)\))?$` suffix.

Returns the body and the qualifier. `[^)]+` forbids a `)` inside, and `\s+`
requires whitespace before the `(`, so `"Miné Mané"` keeps its name and
`"ORAC (waste_disposal)"` splits. -/
def splitTrailingParen (s : String) : String × Option String := Id.run do
  let cs := s.toList
  if cs.isEmpty || cs.getLast! != ')' then return (s, none)
  -- Scan back to the matching '(' with no ')' between.
  let body := cs.dropLast
  let mut i := body.length
  let mut found := none
  while i > 0 do
    let some c := body[i-1]? | break
    if c == ')' then break
    if c == '(' then
      found := some (i-1)
      break
    i := i - 1
  match found with
  | none => return (s, none)
  | some openIdx =>
    if openIdx == 0 then return (s, none)
    let before := body.take openIdx
    if !(before.getLast!.isWhitespace) then return (s, none)
    let inner := (body.drop (openIdx + 1))
    if inner.isEmpty then return (s, none)
    return (String.ofList before |>.trimAscii.toString, some (String.ofList inner |>.trimAscii.toString))

/-! ## The truth cell -/

private def modeWords : Array (String × Mode) := #[
  ("sleeping", .sleeping), ("stationary", .stationary), ("walking", .walking),
  ("cycling", .cycling), ("driving", .driving), ("bus", .bus),
  ("train", .train), ("plane", .plane)]

/-- `/^(verb)\b\s*(.*)$/` — the leading mode word and what follows it.

`\b` is why "buses" does not read as `bus`: the next character must be a
non-word character or the end. -/
def splitVerb (t : String) : Option (Mode × String) := Id.run do
  for (w, m) in modeWords do
    if t.startsWith w then
      let rest := (t.drop w.length).toString
      if rest.isEmpty || !(isWordChar rest.toList.head!) then
        return some (m, rest.trimAscii.toString)
  return none

/-- `/^(.+?)\s+→\s+([^·]+?)(?:\s*·\s*(.+))?$/` — a transit leg.

⚠ The arrow split and the middle-dot split are both the first: `(.+?)` is
non-greedy and `[^·]` cannot cross a `·`. A station name containing either
would split early; none in the corpus does. -/
def splitTransit (rest : String) : Option (String × String × Option String) := Id.run do
  let some arrowAt := findSub rest " → " | return none
  let from_ := (rest.take arrowAt).toString.trimAscii.toString
  let after := (rest.drop (arrowAt + " → ".length)).toString
  match findSub after "·" with
  | some dotAt =>
    let toRaw := (after.take dotAt).toString.trimAscii.toString
    let line := (after.drop (dotAt + "·".length)).toString.trimAscii.toString
    let (toClean, _) := splitTrailingParen toRaw
    return some (from_, toClean, if line.isEmpty then none else some line)
  | none =>
    let (toClean, _) := splitTrailingParen (after.trimAscii.toString)
    return some (from_, toClean, none)

/-- Parse a truth cell into structured form; `none` when it matches no known
shape — a narrative aside rather than a verdict. -/
def parseTruthCell (text : String) : Option Truth := Id.run do
  let t := (stripStars text).trimAscii.toString
  if t.isEmpty then return none
  let some (mode, rest) := splitVerb t | return none

  if mode == .train || mode == .bus then
    match splitTransit rest with
    | some (f, to, line) =>
      return some { mode, trainFrom := some f, trainTo := some to, lineName := line }
    | none =>
      -- Asymmetric on purpose: "train on X" names the line, as the pipeline's
      -- bare-line rendering does; a bus's "on X" names the road and falls
      -- through to the generic way shape below.
      if mode == .train && rest.startsWith "on " then
        return some { mode, lineName := some ((rest.drop 3).toString.trimAscii.toString) }

  -- "@ Place [(qualifier)]"
  if rest.startsWith "@" then
    let afterAt := (rest.drop 1).toString
    if !afterAt.isEmpty && afterAt.toList.head!.isWhitespace then
      let body := afterAt.trimAscii.toString
      if !body.isEmpty then
        let (place, qual) := splitTrailingParen body
        return some { mode, place := some place, placeQualifier := qual }

  -- "on Way [(qualifier)]"
  if rest.startsWith "on " then
    let body := (rest.drop 3).toString.trimAscii.toString
    if !body.isEmpty then
      let (way, qual) := splitTrailingParen body
      return some { mode, wayName := some way, placeQualifier := qual }

  -- "(qualifier)" alone — the "stationary (unlabelled sliver)" case.
  if rest.startsWith "(" && rest.endsWith ")" then
    let inner := (rest.drop 1).dropEnd 1 |>.toString
    if !inner.isEmpty && !(inner.toList.contains ')') then
      return some { mode, placeQualifier := some inner.trimAscii.toString }

  -- Plain mode, no annotation.
  return some { mode }

/-! ## Status and provenance -/

/-- `/\{(corroborated|user|derived|inferred)\}/i` — first recognised tag wins. -/
def parseProvenance (text : String) : Provenance := Id.run do
  let lower := text.toLower
  let mut best : Option (Nat × Provenance) := none
  for (tag, p) in [("{corroborated}", Provenance.corroborated), ("{user}", .user),
                   ("{derived}", .derived), ("{inferred}", .inferred)] do
    match findSub lower tag with
    | some i => if best.all (fun (j, _) => i < j) then best := some (i, p)
    | none => pure ()
  return (best.map Prod.snd).getD .unspecified

/-- Free-text status to one of four canonical values.

The provenance tag is stripped before matching, since `parseProvenance` reads
it separately and `correct {user}` would otherwise fall through to `unclear`.
Anything qualified ("likely correct") is `unclear`: it cannot be scored. -/
def normaliseStatus (text : String) : Status :=
  let t := (stripBraceRuns (stripStars text)).trimAscii.toString.toLower
  if t == "wrong" then .wrong
  else if t == "correct" then .correct
  else if t == "partial" then .«partial»
  else .unclear

/-! ## The table walk -/

/-- `line.split("|")` with the leading and trailing empties of `| … |` dropped.

The trailing empty is dropped only when the line ends with `|`, since
otherwise the last cell is real: free-text notes that overflowed past a closing
pipe. (`splitOn "|"` yields a trailing empty part exactly then, so the test is
redundant; no witness can tell the difference.) -/
def splitTableRow (line : String) : Array String := Id.run do
  let mut parts := (line.splitOn "|").toArray
  if (parts[0]?.map (·.trimAscii.toString.isEmpty)).getD false then
    parts := parts.extract 1 parts.size
  if line.trimAsciiEnd.toString.endsWith "|"
     && (parts.back?.map (·.trimAscii.toString.isEmpty)).getD false then
    parts := parts.extract 0 (parts.size - 1)
  return parts

/-- A `\d{2}` at `i`, as a value. -/
private def two (cs : List Char) (i : Nat) : Option Nat :=
  match cs[i]?, cs[i+1]? with
  | some a, some b =>
    if a.isDigit && b.isDigit then some ((a.toNat - 48) * 10 + (b.toNat - 48)) else none
  | _, _ => none

/-- `/^(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})$/`.

⚠ Both dashes: the corpus uses an en dash, and a plain hyphen also matches;
accepting only one would drop rows without failing. -/
def parseWindow (t : String) : Option (Nat × Nat × Nat × Nat) := Id.run do
  let cs := t.toList
  let some sh := two cs 0 | return none
  if cs[2]? != some ':' then return none
  let some sm := two cs 3 | return none
  let mut i := 5
  while (cs[i]?.map Char.isWhitespace).getD false do i := i + 1
  match cs[i]? with
  | some c => if c != '–' && c != '-' then return none
  | none => return none
  i := i + 1
  while (cs[i]?.map Char.isWhitespace).getD false do i := i + 1
  let some eh := two cs i | return none
  if cs[i+2]? != some ':' then return none
  let some em := two cs (i+3) | return none
  if i + 5 != cs.length then return none
  return some (sh, sm, eh, em)

/-- `/^Times:\s*(zone)\s*$/m` — a file may declare the zone its clock times were
written in, which OVERRIDES the caller's. Needed when a narrative was written in
the zone the day was lived in rather than the fixture's display zone. -/
def declaredTz (markdown : String) : Option String := Id.run do
  for line in markdown.splitOn "\n" do
    let t := line.trimAscii.toString
    if t.startsWith "Times:" then
      let z := (t.drop 6).toString.trimAscii.toString
      if !z.isEmpty then return some z
  return none

private def isHeaderRow (cells : Array String) : Bool :=
  (cells[0]?.map fun c => decide ((c.toLower.splitOn "window").length > 1)).getD false

private def isSeparatorRow (cells : Array String) : Bool :=
  cells.all fun c =>
    let t := c.toList
    !t.isEmpty && t.all (fun ch => ch.isWhitespace || ch == ':' || ch == '-')

/-- Parse one narrative into structured, day-anchored rows.

⚠ The day cursor is the subtle part. Rows are walked in table order; when a
row's start time decreases from the previous row's, the cursor advances a day.
That is how a table puts tonight's sleep at the bottom.

The first row anchors to the previous day only when it is an overnight stay
that wraps past midnight: after noon and ending at or before its own start. An
evening activity that does not wrap ("19:27 – 20:40 dinner") anchors to `date`,
or a table holding only that row would sit a day early and match nothing. -/
def parseGroundTruth (markdown : String) (date : String) (tz : String) : Day := Id.run do
  let tz := (declaredTz markdown).getD tz
  let mut raw : Array (String × Nat × Nat × Nat × Nat × String × String × Option String) := #[]
  let mut inAudit := false
  for line in markdown.splitOn "\n" do
    let t := line.trimAscii.toString
    let lower := t.toLower
    if lower.startsWith "## audit of" then
      inAudit := true
      continue
    if inAudit && t.startsWith "##" then break
    if !inAudit then continue
    if !t.startsWith "|" then continue
    let cells := splitTableRow line
    if cells.size < 3 then continue
    if isHeaderRow cells then continue
    if isSeparatorRow cells then continue
    -- Three cells at least, checked above.
    let some c0 := cells[0]? | continue
    let some c1 := cells[1]? | continue
    let some c2 := cells[2]? | continue
    let windowText := c0.trimAscii.toString
    let some (sh, sm, eh, em) := parseWindow windowText | continue
    let truthText := c1.trimAscii.toString
    let statusText := c2.trimAscii.toString
    let correct :=
      if cells.size >= 4 then
        (String.intercalate "|" (cells.extract 3 cells.size).toList).trimAscii.toString
      else ""
    raw := raw.push (windowText, sh, sm, eh, em, truthText, statusText,
                     if correct.isEmpty then none else some correct)

  let mut anchor := date
  match raw[0]? with
  | some (_, sh, sm, eh, em, _, _, _) =>
    if sh ≥ 12 && eh * 60 + em ≤ sh * 60 + sm then
      anchor := (Verified.Civil.addDays date (-1)).getD date
  | none => pure ()

  let mut rows : Array Row := #[]
  let mut prevStart : Int := -1
  for (windowText, sh, sm, eh, em, truthText, statusText, correct) in raw do
    let cur : Int := (sh * 60 + sm : Nat)
    if prevStart != -1 && cur < prevStart then
      anchor := (Verified.Civil.addDays anchor 1).getD anchor
    prevStart := cur
    let endDay :=
      if (eh * 60 + em : Nat) ≤ (sh * 60 + sm : Nat) then
        (Verified.Civil.addDays anchor 1).getD anchor
      else anchor
    rows := rows.push {
      windowText, startDay := anchor, startHh := sh, startMm := sm,
      endDay, endHh := eh, endMm := em,
      truthText, truth := parseTruthCell truthText,
      status := normaliseStatus statusText,
      provenance := parseProvenance (statusText ++ " " ++ correct.getD ""),
      statusText, correctVersionText := correct }
  return { date, tz, rows }

/-! ## Witnesses

⚠ Every cell below is synthetic: `tests/golden/ground-truth/` is gitignored,
since the narratives name real places, clinics and hotels and these repos are
public. The shapes are reproduced with invented names, and the real corpus is
checked by a local-only harness that announces a skip.

The categories are every structural shape the real corpus's rows produce,
grouped by which fields come back non-null, with their counts:

    23 walking:way      22 stationary:place     20 train:fromTo+line
    11 stationary:place+qual   10 train:fromTo   3 sleeping:place+qual
     2 bus:fromTo+line   2 driving:qual  2 driving:way  2 walking:qual
     1 each: bus:way, driving:bare, sleeping:place, stationary:bare,
             stationary:way, walking:bare, walking:way+qual, UNPARSEABLE
-/

section Witnesses

private def cell (s : String) : Option Truth := parseTruthCell s

-- A narrative aside is not a verdict: no leading mode word, so no truth.
#guard (cell "(arrival: a brief walk, then dinner)").isNone
#guard (cell "").isNone
#guard (cell "   ").isNone

-- Bare modes.
#guard cell "walking" == some { mode := .walking }
#guard cell "driving" == some { mode := .driving }
#guard cell "stationary" == some { mode := .stationary }

-- Places, with and without the amenity qualifier.
#guard cell "stationary @ Home" == some { mode := .stationary, place := some "Home" }
#guard cell "sleeping @ Home" == some { mode := .sleeping, place := some "Home" }
#guard cell "sleeping @ Northern Hotel (hotel)"
       == some { mode := .sleeping, place := some "Northern Hotel", placeQualifier := some "hotel" }
#guard cell "stationary @ Riverside General (hospital)"
       == some { mode := .stationary, place := some "Riverside General", placeQualifier := some "hospital" }

-- Ways. ⚠ A way name may contain a comma and stays whole.
#guard cell "walking on Example Rise" == some { mode := .walking, wayName := some "Example Rise" }
#guard cell "walking on Hofweg, Molenstraat"
       == some { mode := .walking, wayName := some "Hofweg, Molenstraat" }
#guard cell "driving on Market Street" == some { mode := .driving, wayName := some "Market Street" }
#guard cell "stationary on Northern Heliport" == some { mode := .stationary, wayName := some "Northern Heliport" }
#guard cell "walking on Towpath (footpath)"
       == some { mode := .walking, wayName := some "Towpath", placeQualifier := some "footpath" }

-- Qualifier alone.
#guard cell "walking (unlabelled sliver)"
       == some { mode := .walking, placeQualifier := some "unlabelled sliver" }
#guard cell "driving (short hop)" == some { mode := .driving, placeQualifier := some "short hop" }

-- Transit legs.
#guard cell "train Northgate → Southgate"
       == some { mode := .train, trainFrom := some "Northgate", trainTo := some "Southgate" }
#guard cell "train Northgate → Southgate · Metropolitan Line"
       == some { mode := .train, trainFrom := some "Northgate", trainTo := some "Southgate",
                 lineName := some "Metropolitan Line" }
#guard cell "bus Northgate → Southgate · 38"
       == some { mode := .bus, trainFrom := some "Northgate", trainTo := some "Southgate",
                 lineName := some "38" }

-- ⚠ A TRAILING PARENTHETICAL ON THE ALIGHT IS COMMENTARY, NOT A LINE. Only a
-- `· Line` suffix asserts one, so this must NOT set `lineName`.
#guard cell "train Northgate → Southgate (Circle/H&C/Met)"
       == some { mode := .train, trainFrom := some "Northgate", trainTo := some "Southgate" }

-- ⚠ THE `on` ASYMMETRY, and it is deliberate in the original: for a TRAIN it
-- names the LINE (mirroring the pipeline's bare-line rendering); for a BUS it
-- names the ROAD and falls through to the generic way shape.
#guard cell "train on Circle Line" == some { mode := .train, lineName := some "Circle Line" }
#guard cell "bus on Market Street" == some { mode := .bus, wayName := some "Market Street" }

-- ⚠ `\b` after the verb: a longer word that merely STARTS with a mode name is
-- not that mode. Without the boundary check "planeload" would parse as `plane`.
#guard (cell "planeload of freight").isNone
#guard (cell "buses replaced the service").isNone

-- Emphasis is presentation and is stripped before anything else.
#guard cell "**walking on Example Rise**" == some { mode := .walking, wayName := some "Example Rise" }

/-! ### Status and provenance -/

#guard normaliseStatus "correct" == .correct
#guard normaliseStatus "wrong" == .wrong
#guard normaliseStatus "partial" == .«partial»
#guard normaliseStatus "**wrong**" == .wrong
-- ⚠ The provenance tag is stripped before the verdict is matched. Without that,
-- every annotated row would fall through to `unclear` and gate nothing.
#guard normaliseStatus "correct {user}" == .correct
#guard normaliseStatus "**wrong** {derived}" == .wrong
-- Anything qualified cannot be scored against.
#guard normaliseStatus "likely correct" == .unclear
#guard normaliseStatus "" == .unclear
#guard normaliseStatus "unclear" == .unclear

#guard parseProvenance "correct {user}" == .user
#guard parseProvenance "{CORROBORATED}" == .corroborated
#guard parseProvenance "{derived} and later {user}" == .derived
#guard parseProvenance "no tag here" == .unspecified
#guard parseProvenance "{inferred}" == .inferred

-- ⚠ THE PROVENANCE LADDER IS WHAT STOPS A PIPELINE GUESS GATING A CHECK.
-- `inferred` is read back from the pipeline's own output; `unspecified` is an
-- un-annotated legacy row. Neither may enforce.
#guard trusted .corroborated && trusted .user && trusted .derived
#guard !trusted .inferred && !trusted .unspecified

private def row (st : Status) (pv : Provenance) : Row :=
  { windowText := "09:00 – 10:00", startDay := "2026-05-15", startHh := 9, startMm := 0,
    endDay := "2026-05-15", endHh := 10, endMm := 0, truthText := "walking",
    truth := some { mode := .walking }, status := st, provenance := pv,
    statusText := "", correctVersionText := none }

#guard isEnforceable (row .correct .user)
#guard isEnforceable (row .wrong .derived)
#guard !isEnforceable (row .correct .inferred)
#guard !isEnforceable (row .correct .unspecified)
#guard !isEnforceable (row .«partial» .user)
#guard !isEnforceable (row .unclear .corroborated)

/-! ### The table walk

Synthetic narratives, for the same reason as the cells above: the real ones are
gitignored. Each exercises one decision of the day cursor. -/

private def doc (rows : List String) : String :=
  String.intercalate "\n" (["# A day", "", "Some narrative prose.", "",
                            "## Audit of 2026-05-15 blessed golden", "",
                            "| Window | Truth | Status |",
                            "| --- | --- | --- |"] ++ rows ++
                           ["", "## Notes after the table", "",
                            "| 09:00 – 10:00 | walking | correct |"])

-- Rows before the audit heading and after the NEXT heading are both ignored:
-- the table is the structured signal, the prose around it is not.
#guard (parseGroundTruth (doc ["| 09:00 – 10:00 | walking | correct |"])
          "2026-05-15" "Europe/London").rows.size == 1

-- Header and separator rows are skipped, and a row with too few cells is not a
-- verdict.
#guard (parseGroundTruth (doc ["| Window | Truth | Status |", "| :--- | --- | ---: |",
                               "| 09:00 – 10:00 | walking | correct |", "| 11:00 – 12:00 |"])
          "2026-05-15" "Europe/London").rows.size == 1

-- ⚠ BOTH DASHES parse. The corpus uses an en dash; accepting only one would
-- drop rows silently rather than fail.
#guard parseWindow "09:00 – 10:00" == some (9, 0, 10, 0)
#guard parseWindow "09:00 - 10:00" == some (9, 0, 10, 0)
#guard parseWindow "09:00–10:00" == some (9, 0, 10, 0)
#guard (parseWindow "9:00 – 10:00").isNone
#guard (parseWindow "09:00 – 10:00 extra").isNone

/-! #### The day cursor -/

private def days (rows : List String) : List (String × String) :=
  ((parseGroundTruth (doc rows) "2026-05-15" "Europe/London").rows.map
    (fun r => (r.startDay, r.endDay))).toList

-- A plain daytime table stays on the file's date.
#guard days ["| 09:00 – 10:00 | walking | correct |",
             "| 11:00 – 12:00 | stationary @ Work | correct |"]
       == [("2026-05-15", "2026-05-15"), ("2026-05-15", "2026-05-15")]

-- ⚠ A START THAT DECREASES ADVANCES THE CURSOR. That is how a table puts
-- tonight's sleep at the bottom and means the NEXT calendar day.
#guard days ["| 09:00 – 10:00 | walking | correct |",
             "| 23:00 – 07:00 | sleeping @ Home | correct |",
             "| 08:00 – 09:00 | walking | correct |"]
       == [("2026-05-15", "2026-05-15"), ("2026-05-15", "2026-05-16"),
           ("2026-05-16", "2026-05-16")]

-- ⚠ THE FIRST ROW ANCHORS TO THE PREVIOUS DAY ONLY IF IT WRAPS. An overnight
-- stay that starts after noon and ends at or before its own start belongs to
-- the previous evening.
#guard days ["| 23:16 – 09:08 | sleeping @ Home | correct |"]
       == [("2026-05-14", "2026-05-15")]

-- ...and an after-noon activity that does NOT wrap stays on the date. Without
-- the wrap test this anchored a full day early and could never match a state.
#guard days ["| 19:27 – 20:40 | stationary @ Home | correct |"]
       == [("2026-05-15", "2026-05-15")]

-- A window ending at or before its own start crosses midnight.
#guard days ["| 09:00 – 10:00 | walking | correct |",
             "| 22:00 – 02:00 | sleeping @ Home | correct |"]
       == [("2026-05-15", "2026-05-15"), ("2026-05-15", "2026-05-16")]

/-! #### The declared zone -/

-- ⚠ A FILE MAY OVERRIDE THE CALLER'S ZONE, and two of the 32 real narratives
-- do — one written in CEST for a Netherlands trip, one transcribed from UTC.
-- Reading them in the fixture's display zone would shift every row.
#guard (parseGroundTruth (doc ["| 09:00 – 10:00 | walking | correct |"])
          "2026-05-15" "Europe/London").tz == "Europe/London"
#guard (parseGroundTruth ("Times: Europe/Amsterdam\n" ++ doc ["| 09:00 – 10:00 | walking | correct |"])
          "2026-05-15" "Europe/London").tz == "Europe/Amsterdam"
#guard (parseGroundTruth ("Times: UTC\n" ++ doc ["| 09:00 – 10:00 | walking | correct |"])
          "2026-05-15" "Europe/London").tz == "UTC"

/-! #### Cells -/

-- ⚠ A NOTES CELL THAT OVERFLOWED PAST ITS CLOSING PIPE IS STILL REAL. The
-- trailing empty is dropped only when the line genuinely ends with `|`.
#guard splitTableRow "| a | b | c |" == #[" a ", " b ", " c "]
#guard splitTableRow "| a | b | c " == #[" a ", " b ", " c "]

-- The fourth cell onward is the notes column, rejoined verbatim.
#guard ((parseGroundTruth (doc ["| 09:00 – 10:00 | walking | correct | note | more |"])
          "2026-05-15" "Europe/London").rows[0]!).correctVersionText == some "note | more"
#guard ((parseGroundTruth (doc ["| 09:00 – 10:00 | walking | correct |"])
          "2026-05-15" "Europe/London").rows[0]!).correctVersionText == none

-- Provenance is read from the status AND the notes cell together.
#guard ((parseGroundTruth (doc ["| 09:00 – 10:00 | walking | correct | {derived} from cadence |"])
          "2026-05-15" "Europe/London").rows[0]!).provenance == .derived

end Witnesses

end Verified.Eval.GroundTruth
