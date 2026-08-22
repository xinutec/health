/-!
# Flattening client text into one log field (port of `src/routes/api.ts`)

`/api/telemetry` writes UI text the browser sent into a log line as `label=…`.
That makes this a SECURITY BOUNDARY rather than tidiness: a newline inside a
label forges WHOLE LOG LINES, including further `client-event` lines attributed
to someone else. The log stops being evidence, which is the one thing it is for.

The TypeScript is two regexes and a slice:

    raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
       .replace(/\s+/g, " ").trim()
    then [...that].slice(0, max)

Each part earns its place:

* **The category set** covers more than `\n`. `\r` alone moves a cursor, U+2028
  and U+2029 end a line in some readers, and the `Cf` formatting characters
  include bidi overrides that can reorder a line as displayed — so a label can
  lie about which field it is without containing a newline at all.
* **`\s+ → " "`** collapses what is left, including the spaces the first step
  just produced.
* **The cap counts CODE POINTS**, not UTF-16 units and not bytes, so a
  multi-byte glyph is never split down the middle into a replacement character.

⚠ THE RANGES BELOW WERE DERIVED FROM V8, NOT FROM A UNICODE CHART. Every code
point in `[0, 0x10FFFF]` was tested against the two production regexes under
Node and the matching ranges recorded — see `lean/experiments/logline-refs.mts`.
Transcribing them by hand would have meant guessing which Unicode version the
engine uses.

⚠ THEY ARE THEREFORE A SNAPSHOT OF ONE ENGINE VERSION. A future V8 that adopts
a newer Unicode could classify a new code point as `Cf` and this would not know.
The failure direction is a character passing through unflattened, so the cap and
the whitespace collapse still hold — but a re-derivation belongs in any Node
upgrade.

Pure and total. UNPROVEN.
-/
namespace Verified.LogLine

/-- `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}` — as V8 matches them. Inclusive. -/
def CATEGORY_RANGES : List (Nat × Nat) :=
  [ (0, 31), (127, 159), (173, 173), (1536, 1541), (1564, 1564), (1757, 1757)
  , (1807, 1807), (2192, 2193), (2274, 2274), (6158, 6158), (8203, 8207)
  , (8232, 8238), (8288, 8292), (8294, 8303), (65279, 65279), (65529, 65531)
  , (69821, 69821), (69837, 69837), (78896, 78911), (113824, 113827)
  , (119155, 119162), (917505, 917505), (917536, 917631) ]

/-- `\s` — as V8 matches it. Inclusive.

⚠ NOT the same set as above and neither contains the other. U+00A0 and the
U+2000 block are whitespace but not control-like, so they survive the first
replacement and are collapsed by the second. -/
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
        -- ⚠ ONE space per RUN, not one per character.
        if prevWs then go rest true else ' ' :: go rest true
      else c :: go rest false
  let collapsed := go cs false
  -- `.trim()`. At most one space can be at each end after the collapse.
  let dropped := collapsed.dropWhile isJsWhitespace
  (dropped.reverse.dropWhile isJsWhitespace).reverse

/-- Flatten client text to a single harmless log field, capped at `max` CODE
POINTS. -/
def oneLine (raw : String) (max : Nat) : String :=
  let flattened := raw.toList.map (fun c => if isControlLike c then ' ' else c)
  String.mk ((collapse flattened).take max)

/-! ## Guards -/

-- The ordinary case is untouched.
#guard oneLine "Refresh" 160 == "Refresh"
#guard oneLine "" 160 == ""

-- ⚠ THE ATTACK. A newline would otherwise forge a second log line attributed to
-- someone else.
#guard oneLine "a\nclient-event user=victim" 160 == "a client-event user=victim"
#guard oneLine "a\rb" 160 == "a b"
#guard oneLine "a\r\nb" 160 == "a b"
-- U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR end a line in readers
-- that a bare `\n` check would miss.
#guard oneLine "a b" 160 == "a b"
#guard oneLine "a b" 160 == "a b"
-- A bidi override can reorder the line as displayed without any newline.
#guard oneLine "a‮b" 160 == "a b"
-- Zero-width and BOM.
#guard oneLine "a​b" 160 == "a b"
#guard oneLine "a﻿b" 160 == "a b"

-- Runs collapse to ONE space, and the ends are trimmed.
#guard oneLine "a   b" 160 == "a b"
#guard oneLine "  a  b  " 160 == "a b"
#guard oneLine "\t\n\r a" 160 == "a"
#guard oneLine "   " 160 == ""
-- Whitespace that is NOT control-like still collapses.
#guard oneLine "a b" 160 == "a b"
#guard oneLine "a　b" 160 == "a b"

-- The cap counts code points.
#guard oneLine "abcdef" 3 == "abc"
#guard oneLine "abc" 10 == "abc"
#guard oneLine "abcdef" 0 == ""
-- ⚠ An astral character is ONE code point, not two UTF-16 units — a cap that
-- counted units could split a surrogate pair and emit a lone half.
#guard (oneLine "𝄞𝄞𝄞" 2).length == 2
#guard oneLine "𝄞𝄞𝄞" 2 == "𝄞𝄞"

end Verified.LogLine
