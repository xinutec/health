import Lean.Data.Json
import Verified.Sync

/-!
# The backend's C ABI entry point

`rust/backend` links this the way `rust/day-shell` links `DayEntry`, so the
decisions in `Verified.Sync` are called by the running backend rather than
reimplemented beside it.

⚠ IT IS A `lean_lib` AND NOT A `lean_exe`, for the reason `DayEntry`'s comment
gives: an exe's root module also emits `main`, and an archive carrying `_main`
wins the link in a foreign host SILENTLY — it builds, runs, and answers from the
wrong entry point. Nothing here defines `main`, so there is nothing to collide.

String in, string out, matching `DayEntry`: the narrowest C ABI that still
carries a request, with no structs to keep in sync across three languages. These
particular calls are small enough that a JSON round trip is invisible next to
the HTTP request or the database round trip that surrounds them — the rate-limit
decision runs once per Fitbit call, and the cursor walk once per backfilled day.

# Why a dispatch rather than one export per function

One symbol to declare in the shim, one to keep working across a toolchain bump.
Adding a decision here costs a `match` arm and nothing in C or Rust, which is
the property that matters while the port is still moving.
-/

namespace BackendEntry

open Lean (Json)

private def err (msg : String) : Json := Json.mkObj [("error", Json.str msg)]

/-- A required string field. -/
private def str? (j : Json) (k : String) : Option String :=
  match j.getObjVal? k with
  | .ok v => match v.getStr? with | .ok s => some s | .error _ => none
  | .error _ => none

/-- A required integer field. Accepts only a JSON number that is integral —
a fractional `windowDays` is a caller bug, not something to round here. -/
private def int? (j : Json) (k : String) : Option Int :=
  match j.getObjVal? k with
  | .ok v => match v.getInt? with | .ok i => some i | .error _ => none
  | .error _ => none

private def rateLimitJson : Verified.Sync.RateLimitAction → Json
  | .proceed => Json.mkObj [("kind", Json.str "proceed")]
  | .sleep ms => Json.mkObj [("kind", Json.str "sleep"), ("ms", Json.num (.fromNat ms.toNat))]
  | .exhausted s =>
    Json.mkObj [("kind", Json.str "exhausted"), ("resumeInSec", Json.num (.fromNat s.toNat))]

/-- `none` is a first-class answer here, not an error: every caller of
`prevDayBounded` and `prevWindowBounded` treats it as "stop the walk". -/
private def optStr : Option String → Json
  | none => Json.null
  | some s => Json.str s

def dispatch (j : Json) : Json :=
  match str? j "op" with
  | none => err "missing op"
  | some "decideRateLimitWait" =>
    match int? j "remaining", int? j "msUntilReset", int? j "maxWaitMs" with
    | some r, some u, some m => rateLimitJson (Verified.Sync.decideRateLimitWait r u m)
    | _, _, _ => err "decideRateLimitWait: remaining, msUntilReset, maxWaitMs required"
  | some "prevDayBounded" =>
    match str? j "date", str? j "floor" with
    | some d, some f => Json.mkObj [("value", optStr (Verified.Sync.prevDayBounded d f))]
    | _, _ => err "prevDayBounded: date, floor required"
  | some "prevWindowBounded" =>
    match str? j "end", int? j "windowDays", str? j "floor" with
    | some e, some w, some f =>
      match Verified.Sync.prevWindowBounded e w f with
      | none => Json.mkObj [("value", Json.null)]
      | some (s, e') =>
        Json.mkObj [("value", Json.mkObj [("start", Json.str s), ("end", Json.str e')])]
    | _, _, _ => err "prevWindowBounded: end, windowDays, floor required"
  | some "dateRangeInclusive" =>
    match str? j "start", str? j "end", int? j "maxDays" with
    | some s, some e, some m =>
      match Verified.Sync.dateRangeInclusive s e m with
      | none => Json.mkObj [("value", Json.null)]
      | some ds => Json.mkObj [("value", Json.arr (ds.map Json.str).toArray)]
    | _, _, _ => err "dateRangeInclusive: start, end, maxDays required"
  | some other => err s!"unknown op: {other}"

@[export health_backend_call]
def backendCallExport (input : String) : String :=
  match Json.parse input with
  | .error e => (err s!"parse: {e}").compress
  | .ok j => (dispatch j).compress

end BackendEntry
