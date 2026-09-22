import Lean.Data.Json

/-!
# `Host` — the one question the fold can put to the process that runs it

Every lookup the day fold cannot compute — the OSM mirror, the zone at a
coordinate, a geocode — is one `ask`: a table name and a key, answered by
whoever spawned `verified_cli serve` (#1709). The host reads asks off the same
pipe the results come back on, so the protocol on stdout is two line shapes:

    {"ask":{"what":"nearbyStations","key":"<latBits>|<lonBits>|<rBits>"}}
    {"id":…,"result":…}

and the host replies to an ask with ONE line on stdin:

    {"answer": <row>}          the row, in the shape the table's parser reads
    {"answer": null}           a DECLINE — the host cannot vouch for this ground

⚠ **A DECLINE IS NOT AN EMPTY ANSWER** (#1667). "There are no roads here" is a
row (an empty array); "nobody has fetched here" is `null`. The two reach the
fold as `some #[]` and `none`, and every reader keeps them apart.

# Why this is `opaque` with an `IO` implementation

`PassFold.Env` is a record of FUNCTIONS — `Float → Float → Float → Array …` —
and the passes are pure in it. That is what lets a `#guard` build an `Env` from
literals and lets a theorem be parametric in it. Production fills those fields
with `ask`, which reads a pipe: an `@[implemented_by]` body behind an `opaque`
name, exactly as `@[extern]` was before it, but with the transport in Lean
rather than in C. Nothing under `Verified` imports this module.

⚠ `ask` is only meaningful under `verified_cli serve`. Run as a one-shot
(`verified_cli day < request`) the request has already consumed stdin, so every
ask reads EOF and declines — the same answer the C stub used to give.
-/

open Lean (Json)

namespace DayEntry.Host

/-- The line an ask goes out as. -/
def askLine (what key : String) : String :=
  (Json.mkObj [("ask", Json.mkObj [("what", Json.str what), ("key", Json.str key)])]).compress

/-- The host's reply line, read back: `some row`, or `none` for a decline, an
unparseable line, or a line with no `answer` at all. -/
def parseReply (line : String) : Option Json :=
  match Json.parse line with
  | .error _ => none
  | .ok j =>
    match j.getObjVal? "answer" with
    | .ok v => if v.isNull then none else some v
    | .error _ => none

/-- Write the ask, flush, read one line. EOF is a decline. -/
unsafe def askImpl (what key : String) : Option Json :=
  let io : IO (Option Json) := do
    let out ← IO.getStdout
    out.putStr (askLine what key)
    out.putStr "\n"
    out.flush
    let line ← (← IO.getStdin).getLine
    if line.isEmpty then return none
    return parseReply line
  match unsafeBaseIO io.toBaseIO with
  | .ok v => v
  | .error _ => none

/-- One question to the host. See the module header for the wire. -/
@[implemented_by askImpl]
opaque ask (what key : String) : Option Json

/-- `ask`, then parse the row; a row the parser refuses is a decline too, and
the refusal is not silent — the host wrote a shape this side does not read,
which is the class of defect this repo keeps being bitten by. -/
def askAs (what key : String) (parse : Json → Except String α) : Option α :=
  match ask what key with
  | none => none
  | some row =>
    match parse row with
    | .ok v => some v
    | .error e => dbgTrace s!"host: {what}({key}) answered a row this side cannot read: {e}" fun _ => none

#guard askLine "tzAt" "1|2" == "{\"ask\":{\"key\":\"1|2\",\"what\":\"tzAt\"}}"
#guard parseReply "{\"answer\":null}" == none
#guard parseReply "{\"answer\":[1,2]}" == some (Json.arr #[1, 2])
#guard parseReply "not json" == none
#guard parseReply "{\"result\":1}" == none

end DayEntry.Host
