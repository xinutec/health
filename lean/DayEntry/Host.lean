import Lean.Data.Json

/-!
# `Host` — the one question the fold can put to the process that runs it

Every lookup the fold cannot compute (the OSM mirror, the zone at a coordinate,
a geocode) is one `ask`: a table name and a key, answered by whoever spawned
`verified_cli serve`, on the result pipe. Stdout carries two line shapes:

    {"ask":{"what":"nearbyStations","key":"<latBits>|<lonBits>|<rBits>"}}
    {"id":…,"result":…}

and the host answers an ask with one line on stdin:

    {"answer": <row>}          the row, in the shape the table's parser reads
    {"answer": null}           a decline: the host cannot vouch for this ground

⚠ A decline is not an empty answer: "no roads here" is an empty array,
"nobody fetched here" is `null`; they reach the fold as `some #[]` and `none`.

`PassFold.Env` is a record of functions, so guards build it from literals and
theorems are parametric in it; production fills it with `ask`, an
`@[implemented_by]` IO body behind an `opaque` name. Nothing under `Verified`
imports this. Outside `verified_cli serve`, stdin is consumed and every ask
declines.
-/

open Lean (Json)

namespace DayEntry.Host

/-! ## Where a day's time goes

Wall-clock spans summed by name, read once per day by `takeTimings` and shipped
as `lean.<name>` timings. `timed` is `f ()` to every proof; only the binary
reads the clock. -/

initialize spansRef : IO.Ref (Array (String × Nat)) ← IO.mkRef #[]

/-- Add `ns` to the span `name`. -/
def addSpan (name : String) (ns : Nat) : BaseIO Unit :=
  spansRef.modify fun a =>
    match a.findIdx? (·.1 == name) with
    | some i => a.modify i fun (n, t) => (n, t + ns)
    | none => a.push (name, ns)

unsafe def timedImpl {α : Type} (name : String) (f : Unit → α) : α :=
  let io : IO α := do
    let t0 ← IO.monoNanosNow
    let r ← IO.lazyPure f
    let t1 ← IO.monoNanosNow
    addSpan name (t1 - t0)
    pure r
  match unsafeBaseIO io.toBaseIO with
  | .ok r => r
  | .error _ => f ()

/-- `f ()`, timed under `name` in the compiled binary. -/
@[implemented_by timedImpl]
def timed {α : Type} (name : String) (f : Unit → α) : α := f ()

unsafe def takeTimingsImpl (dep : Nat) : Json :=
  unsafeBaseIO do
    let a ← spansRef.modifyGet fun a => (a, #[])
    -- ⚠ `dep` must reach the result. A body that never mentions the argument is
    -- a closed term, and the compiler lifts it out and runs it once: every later
    -- fold in the same worker would report the first fold's timings.
    let tail := if dep == 0x7fffffffffff then [("dep", Lean.toJson dep)] else []
    pure (Json.mkObj ((a.toList.map fun (n, ns) => (n, Lean.toJson (ns / 1000000))) ++ tail))

/-- The spans so far as `{name: ms}`, and reset. `_dep` is any value computed
after the spans it should include: without a data dependency the call is a
closed term the compiler may evaluate once, at start-up. -/
@[implemented_by takeTimingsImpl]
def takeTimings (_dep : Nat) : Json := Json.mkObj []

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
    let t0 ← IO.monoNanosNow
    let line ← (← IO.getStdin).getLine
    let t1 ← IO.monoNanosNow
    addSpan s!"ask.{what}.wait" (t1 - t0)
    if line.isEmpty then return none
    let r ← IO.lazyPure fun _ => parseReply line
    let t2 ← IO.monoNanosNow
    addSpan s!"ask.{what}.parse" (t2 - t1)
    return r
  match unsafeBaseIO io.toBaseIO with
  | .ok v => v
  | .error _ => none

unsafe def tellImpl {α : Type} (what key : String) (v : α) : α :=
  let io : IO Unit := do
    let out ← IO.getStdout
    out.putStr (askLine what key)
    out.putStr "\n"
    out.flush
    let _ ← (← IO.getStdin).getLine
  -- Two different results, so the call cannot be folded away as unused.
  match unsafeBaseIO io.toBaseIO with
  | .ok _ => v
  | .error _ => dbgTrace s!"lean: telling the host {what} failed" fun _ => v

/-- Hand the host a value to keep (`memo.*`), and go on with `v`. The host
answers with an empty line; nothing here reads it. -/
@[implemented_by tellImpl]
def tell {α : Type} (_what _key : String) (v : α) : α := v

initialize dumpCounter : IO.Ref Nat ← IO.mkRef 0

unsafe def dumpImpl {α : Type} (what : String) (payload : Unit → String) (v : α) : α :=
  let io : IO Unit := do
    let some dir ← IO.getEnv "LEAN_DUMP_DIR" | return
    let n ← dumpCounter.modifyGet fun n => (n, n + 1)
    IO.FS.writeFile s!"{dir}/{what}-{n}.json" (payload ())
  match unsafeBaseIO io.toBaseIO with
  | .ok _ => v
  | .error _ => dbgTrace s!"lean: dumping {what} failed" fun _ => v

/-- With `LEAN_DUMP_DIR` set, write `payload ()` to `<dir>/<what>-<n>.json`
and go on with `v`; without it, `v`. A solver's input, captured where it is
called, so a profiler (`verified_cli matchprof`) can replay exactly that call. -/
@[implemented_by dumpImpl]
def dump {α : Type} (_what : String) (_payload : Unit → String) (v : α) : α := v

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
