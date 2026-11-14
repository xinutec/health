/-!
# Flattening client text into one log field

`/api/telemetry` writes browser-sent UI text into a log line as `label=…`, so
this is a security boundary: a newline in a label forges log lines attributed
to someone else.

    raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
       .replace(/\s+/g, " ").trim()
    then [...that].slice(0, max)

The categories cover more than `\n`: `\r`, U+2028/U+2029, and `Cf` bidi
overrides that reorder a displayed line. `\s+ → " "` collapses the rest. The
cap counts code points, so no glyph is split.

The ranges were derived by testing every code point, so they are one Unicode
version's snapshot; a newly classified `Cf` would pass through unflattened, with
the cap and collapse still holding.

Pure and total. UNPROVEN.
-/
namespace Verified.LogLine

/-- `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`. Inclusive. -/
def CATEGORY_RANGES : List (Nat × Nat) :=
  [ (0, 31), (127, 159), (173, 173), (1536, 1541), (1564, 1564), (1757, 1757)
  , (1807, 1807), (2192, 2193), (2274, 2274), (6158, 6158), (8203, 8207)
  , (8232, 8238), (8288, 8292), (8294, 8303), (65279, 65279), (65529, 65531)
  , (69821, 69821), (69837, 69837), (78896, 78911), (113824, 113827)
  , (119155, 119162), (917505, 917505), (917536, 917631) ]

/-- `\s`, inclusive. Overlaps the set above without containing it: U+00A0 and
the U+2000 block survive the first replacement and collapse in the second. -/
def WHITESPACE_RANGES : List (Nat × Nat) :=
  [ (9, 13), (32, 32), (160, 160), (5760, 5760), (8192, 8202), (8232, 8233)
  , (8239, 8239), (8287, 8287), (12288, 12288), (65279, 65279) ]

private def inRanges (ranges : List (Nat × Nat)) (c : Char) : Bool :=
  ranges.any (fun (lo, hi) => lo ≤ c.toNat && c.toNat ≤ hi)

/-- A character the first replacement turns into a space. -/
def isControlLike (c : Char) : Bool := inRanges CATEGORY_RANGES c

/-- A character JavaScript's `\s` matches. -/
def isJsWhitespace (c : Char) : Bool := inRanges WHITESPACE_RANGES c

/-- Collapse runs of whitespace to one space, then trim. -/
private def collapse (cs : List Char) : List Char :=
  let rec go : List Char → Bool → List Char
    | [], _ => []
    | c :: rest, prevWs =>
      if isJsWhitespace c then
        -- One space per run, not one per character.
        if prevWs then go rest true else ' ' :: go rest true
      else c :: go rest false
  let collapsed := go cs false
  -- `.trim()`. At most one space can be at each end after the collapse.
  let dropped := collapsed.dropWhile isJsWhitespace
  (dropped.reverse.dropWhile isJsWhitespace).reverse

/-- Flatten client text to a single harmless log field, capped at `max` code
points. -/
def oneLine (raw : String) (max : Nat) : String :=
  let flattened := raw.toList.map (fun c => if isControlLike c then ' ' else c)
  String.ofList ((collapse flattened).take max)

/-! ## Guards -/

-- The ordinary case is untouched.
#guard oneLine "Refresh" 160 == "Refresh"
#guard oneLine "" 160 == ""

-- ⚠ the attack. A newline would otherwise forge a second log line attributed to
-- someone else.
#guard oneLine "a\nclient-event user=victim" 160 == "a client-event user=victim"
#guard oneLine "a\rb" 160 == "a b"
#guard oneLine "a\r\nb" 160 == "a b"
-- U+2028 line separator and U+2029 paragraph separator end a line in readers
-- that a bare `\n` check would miss.
#guard oneLine "a b" 160 == "a b"
#guard oneLine "a b" 160 == "a b"
-- A bidi override can reorder the line as displayed without any newline.
#guard oneLine "a‮b" 160 == "a b"
-- Zero-width and BOM.
#guard oneLine "a​b" 160 == "a b"
#guard oneLine "a﻿b" 160 == "a b"

-- Runs collapse to one space, and the ends are trimmed.
#guard oneLine "a   b" 160 == "a b"
#guard oneLine "  a  b  " 160 == "a b"
#guard oneLine "\t\n\r a" 160 == "a"
#guard oneLine "   " 160 == ""
-- Whitespace that is not control-like still collapses.
#guard oneLine "a b" 160 == "a b"
#guard oneLine "a　b" 160 == "a b"

-- The cap counts code points.
#guard oneLine "abcdef" 3 == "abc"
#guard oneLine "abc" 10 == "abc"
#guard oneLine "abcdef" 0 == ""
-- An astral character is one code point, not two UTF-16 units — a cap that
-- counted units could split a surrogate pair and emit a lone half.
#guard (oneLine "𝄞𝄞𝄞" 2).length == 2
#guard oneLine "𝄞𝄞𝄞" 2 == "𝄞𝄞"

end Verified.LogLine
