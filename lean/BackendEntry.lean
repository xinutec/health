import Lean.Data.Json
import Verified.Backfill
import Verified.Civil
import Verified.FitbitTz
import Verified.Token
import Verified.Weight
import Verified.ApiWindow
import Verified.RowShape
import Verified.LocationTail
import Verified.Connection
import Verified.LogLine
import Verified.PhoneTrackPrefs
import Verified.Login
import Verified.Recovery
import Verified.Owntracks
import Verified.Geo.Landmarks
import Verified.Geo.LineStations
import Verified.PresenceLog
import Verified.Geo.CurrentPlace
import Verified.Geo.VenuePrior
import Verified.Geo.FocusMining
import Verified.Hsmm.RouteGraph
import Verified.Session
import Verified.Share
import Verified.Sync
import Verified.VelocityCache

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

private def reasonStr : Verified.Backfill.CompleteReason → String
  | .reachedFloor => "reachedFloor"
  | .cursorUnusable => "cursorUnusable"
  | .emptyStreak => "emptyStreak"

private def stepJson : Verified.Backfill.Step → Json
  | .fetch d => Json.mkObj [("kind", Json.str "fetch"), ("date", Json.str d)]
  | .pause => Json.mkObj [("kind", Json.str "pause")]
  | .complete r =>
    Json.mkObj [("kind", Json.str "complete"), ("reason", Json.str (reasonStr r))]

private def rangeStepJson : Verified.Backfill.RangeStep → Json
  | .fetch s e =>
    Json.mkObj [("kind", Json.str "fetch"), ("start", Json.str s), ("end", Json.str e)]
  | .pause => Json.mkObj [("kind", Json.str "pause")]
  | .complete r =>
    Json.mkObj [("kind", Json.str "complete"), ("reason", Json.str (reasonStr r))]

/-- `[{"name": …, "cursor": … | null}, …]`. A stream whose cursor is absent or
`null` takes the fallback, which is the whole point of the ordering — an
unstarted stream must not queue behind a deep backfill. -/
private def streams? (j : Json) : Option (List (String × Option String)) :=
  match j.getObjVal? "streams" with
  | .error _ => none
  | .ok v =>
    match v.getArr? with
    | .error _ => none
    | .ok arr => arr.toList.mapM fun e =>
      match str? e "name" with
      | none => none
      | some n => some (n, str? e "cursor")

/-- `[{"date": …, "grams": …, "ts": …}, …]`.

⚠ EVERY field is required and a malformed element refuses the whole call rather
than being dropped. A dropped weigh-in is not a smaller answer: it can move the
`replaceFrom` boundary later, leaving the stale forward-filled rows it was
supposed to delete. -/
private def weighIns? (j : Json) : Option (List Verified.Weight.Weigh) :=
  match j.getObjVal? "weighIns" with
  | .error _ => none
  | .ok v =>
    match v.getArr? with
    | .error _ => none
    | .ok arr => arr.toList.mapM fun e =>
      match str? e "date", int? e "grams", str? e "ts" with
      | some d, some g, some t => some ⟨d, g, t⟩
      | _, _, _ => none

/-- The wire name of a [`Verified.RowShape.Shape`]. The host matches on these
strings, so they are part of the interface and renaming one breaks it. -/
private def shapeTag : Verified.RowShape.Shape → String
  | .num => "num"
  | .str => "str"
  | .bigintStr => "bigintStr"
  | .decimalStr => "decimalStr"
  | .dateIso => "dateIso"
  | .dateTimeIso => "dateTimeIso"

private def weighJson (w : Verified.Weight.Weigh) : Json :=
  Json.mkObj
    [ ("date", Json.str w.date)
    , ("grams", Json.num w.grams)
    , ("ts", Json.str w.ts) ]

/-- A required array of strings.

⚠ A non-string element refuses the WHOLE array rather than being skipped. These
are column type names, and a skipped one would shift every later column's shape
onto the wrong column — a silent, well-formed, entirely wrong response. -/
private def strs? (j : Json) (k : String) : Option (List String) :=
  match j.getObjVal? k with
  | .error _ => none
  | .ok v =>
    match v.getArr? with
    | .error _ => none
    | .ok arr => arr.toList.mapM fun e =>
      match e.getStr? with | .ok x => some x | .error _ => none

/-- A required array of integers. -/
private def ints? (j : Json) (k : String) : Option (List Int) :=
  match j.getObjVal? k with
  | .error _ => none
  | .ok v =>
    match v.getArr? with
    | .error _ => none
    | .ok arr => arr.toList.mapM fun e =>
      match e.getInt? with | .ok i => some i | .error _ => none

/-- An OPTIONAL integer, where absent and `null` both mean absent. Distinct
from `int?` failing on a wrong type: `seedUtc` is legitimately absent when the
wall clock did not parse, and that is a decision input rather than a bad call. -/
private def optInt? (j : Json) (k : String) : Option Int :=
  match j.getObjVal? k with
  | .error _ => none
  | .ok v => match v.getInt? with | .ok i => some i | .error _ => none

private def tzChoiceJson : Verified.FitbitTz.TzChoice → Json
  | .profile => Json.mkObj [("kind", Json.str "profile")]
  | .fix i => Json.mkObj [("kind", Json.str "fix"), ("index", Json.num (.fromNat i))]

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
  | some "chunkRange" =>
    match str? j "start", str? j "end", int? j "days", int? j "maxChunks" with
    | some s, some e, some d, some m =>
      match Verified.Sync.chunkRange s e d m with
      | none => Json.mkObj [("value", Json.null)]
      | some cs =>
        Json.mkObj [("value", Json.arr (cs.map (fun (a, b) =>
          Json.mkObj [("start", Json.str a), ("end", Json.str b)])).toArray)]
    | _, _, _, _ => err "chunkRange: start, end, days, maxChunks required"
  -- Both answers in ONE call, deliberately: the delete boundary and the rows
  -- that replace what it deletes have to come from the SAME dedup, or the
  -- window and its contents can disagree.
  | some "dedupeWeighIns" =>
    match weighIns? j with
    | some ms =>
      Json.mkObj
        [ ("replaceFrom", optStr (Verified.Weight.replaceFrom ms))
        , ("kept", Json.arr ((Verified.Weight.dedupeByDate ms).map weighJson).toArray) ]
    | none => err "dedupeWeighIns: weighIns [{date, grams, ts}] required"
  | some "midnightUtc" =>
    match str? j "date" with
    | some d =>
      Json.mkObj [("value",
        match Verified.Civil.midnightUtc d with
        | none => Json.null
        | some s => Json.num s)]
    | none => err "midnightUtc: date required"
  | some "decideBackfillStep" =>
    match int? j "remaining", int? j "emptyStreak", int? j "maxEmpty",
          str? j "cursor", str? j "floor" with
    | some r, some s, some m, some c, some f =>
      stepJson (Verified.Backfill.decideStep r s m c f)
    | _, _, _, _, _ =>
      err "decideBackfillStep: remaining, emptyStreak, maxEmpty, cursor, floor required"
  | some "decideRangeBackfillStep" =>
    match int? j "remaining", int? j "emptyStreak", int? j "maxEmpty", int? j "windowDays",
          str? j "cursor", str? j "floor" with
    | some r, some s, some m, some w, some c, some f =>
      rangeStepJson (Verified.Backfill.decideRangeStep r s m w c f)
    | _, _, _, _, _, _ =>
      err "decideRangeBackfillStep: remaining, emptyStreak, maxEmpty, windowDays, cursor, floor required"
  | some "orderByCursorRecency" =>
    match streams? j, str? j "fallback" with
    | some ss, some f =>
      Json.mkObj [("value",
        Json.arr ((Verified.Backfill.orderByCursorRecency ss f).map Json.str).toArray)]
    | _, _ => err "orderByCursorRecency: streams, fallback required"
  -- ⚠ These two are the SPECIFICATION side of a differential test, not the
  -- production path. The backend binary-searches its own sorted fixes; a JSON
  -- round trip per row would be 86 400 of them for one day of 1-second heart
  -- rate. See `Verified/FitbitTz.lean`'s header.
  | some "nearestFix" =>
    match ints? j "times", int? j "target" with
    | some ts, some t =>
      Json.mkObj [("value",
        match Verified.FitbitTz.nearestFix ts t with
        | none => Json.null
        | some i => Json.num (.fromNat i))]
    | _, _ => err "nearestFix: times, target required"
  | some "decideTz" =>
    match ints? j "times" with
    | some ts => tzChoiceJson (Verified.FitbitTz.decideTz ts (optInt? j "seedUtc"))
    | none => err "decideTz: times required"
  | some "forwardWindow" =>
    match str? j "today" with
    | some t =>
      (match Verified.Sync.forwardWindow t (str? j "storedCursor") with
       | none => Json.mkObj [("value", Json.null)]
       | some (s, e) =>
         Json.mkObj [("value", Json.mkObj [("start", Json.str s), ("end", Json.str e)])])
    | none => err "forwardWindow: today required"
  | some "decideTokenUse" =>
    match int? j "nowMs", int? j "expiresAtMs" with
    | some n, some e =>
      Json.mkObj [("kind", Json.str
        (match Verified.Token.decideTokenUse n e with | .use => "use" | .refresh => "refresh"))]
    | _, _ => err "decideTokenUse: nowMs, expiresAtMs required"
  | some "classifyRefreshStatus" =>
    match int? j "status" with
    | some s =>
      Json.mkObj [("kind", Json.str
        (match Verified.Token.classifyRefreshStatus s with
         | .rotated => "rotated"
         | .reauthRequired => "reauthRequired"
         | .transient => "transient"))]
    | none => err "classifyRefreshStatus: status required"
  | some "expiryFromNow" =>
    match int? j "nowMs" with
    | some n =>
      Json.mkObj [("value", Json.num (Verified.Token.expiryFromNow n (optInt? j "expiresInS")))]
    | none => err "expiryFromNow: nowMs required"
  -- `/velocity`'s cache policy (#982). The map and the in-flight dedup stay in
  -- the host; what crosses here is how long a result may be reused.
  --
  -- ⚠ `today` must be the VIEWER's local civil date, not UTC's. Lean has no zone
  -- database, so this cannot check the caller got that right — see
  -- `Verified.VelocityCache` for what a UTC date silently asks instead.
  | some "velocityTtlMs" =>
    match str? j "date", str? j "today" with
    | some d, some t =>
      Json.mkObj
        [ ("value", Json.num (Verified.VelocityCache.ttlMsFor d t))
        , ("maxEntries", Json.num Verified.VelocityCache.MAX_ENTRIES) ]
    | _, _ => err "velocityTtlMs: date, today required"
  | some "velocityCacheFresh" =>
    match int? j "cachedAtMs", int? j "nowMs", int? j "ttlMs" with
    | some c, some n, some t =>
      Json.mkObj [("value", Json.bool (Verified.VelocityCache.isFresh c n t))]
    | _, _, _ => err "velocityCacheFresh: cachedAtMs, nowMs, ttlMs required"
  -- ⚠ Answers "is it in the window" only. A session with NO share-viewer must
  -- not reach this: it is not a viewer with an empty window, and asking here
  -- would turn a missing window into an admitted date.
  | some "dateInShareWindow" =>
    match str? j "date", str? j "from", str? j "to" with
    | some d, some f, some t =>
      Json.mkObj [("value", Json.bool (Verified.Share.dateInShareWindow d f t))]
    | _, _, _ => err "dateInShareWindow: date, from, to required"
  -- Session and share-viewer rules (#982). The HMAC, the CSPRNG and the
  -- constant-time compare stay in the host — there is nothing to prove about
  -- them beyond that they were asked for.
  --
  -- ⚠ `splitSigned` splits on the LAST separator: the signature is base64url,
  -- which has no `.`, so a value containing dots round-trips whole.
  | some "splitSigned" =>
    match str? j "signed" with
    | some sgn =>
      match Verified.Session.splitSigned sgn with
      | none => Json.mkObj [("value", Json.null)]
      | some (v, sig) =>
        Json.mkObj [("value", Json.mkObj [("value", Json.str v), ("sig", Json.str sig)])]
    | none => err "splitSigned: signed required"
  | some "sessionIsValid" =>
    match int? j "expiresAtMs", int? j "nowMs" with
    | some e, some n =>
      Json.mkObj [("value", Json.bool (Verified.Session.sessionIsValid e n))]
    | _, _ => err "sessionIsValid: expiresAtMs, nowMs required"
  -- ⚠ Answers "may this session do this", NOT "is there a session". An
  -- unauthenticated request is not a share viewer, and `true` here is not
  -- permission — the caller's own session gate runs first.
  | some "mayProceed" =>
    match j.getObjVal? "isShareViewer" >>= (·.getBool?) |>.toOption,
          str? j "method", str? j "path" with
    | some sv, some m, some p =>
      Json.mkObj [("value", Json.bool (Verified.Session.mayProceed sv m p))]
    | _, _, _ => err "mayProceed: isShareViewer, method, path required"
  -- ⚠ `daysBack ≤ 0` and an unparsable `today` BOTH answer null, and the caller
  -- must treat that as "share disabled" rather than "no window". The TypeScript
  -- produced `NaN`-shaped garbage for the second, which formatted as
  -- "NaN-NaN-NaN" and reached the database as a string.
  -- The multi-day API window (#982).
  --
  -- ⚠ `days` is VALIDATED, not clamped: `null` out means REJECT the request.
  -- Answering a `days=400` with a narrowed window would tell the caller nothing
  -- about having asked for something impossible.
  --
  -- ⚠ `days` arrives as what JS `Number(...)` made of the parameter — ABSENT is
  -- `null`, and a present-but-unparseable value is NaN, which JSON cannot carry.
  -- The host sends `daysNaN: true` for that case rather than dropping it, since
  -- a dropped NaN would read as absent and become the default.
  | some "validateDays" =>
    let raw : Option Float :=
      if (j.getObjVal? "daysNaN" >>= (·.getBool?)).toOption == some true then some (0.0 / 0.0)
      else match j.getObjVal? "days" with
        | .error _ => none
        | .ok v => if v.isNull then none else (v.getNum?.toOption.map (·.toFloat))
    match Verified.ApiWindow.validateDays raw with
    | none => Json.mkObj [("value", Json.null)]
    | some n => Json.mkObj [("value", Json.num n)]
  -- ⚠ `shareFrom` absent = the OWNER, who is bounded only by `days`. A host that
  -- sent the owner an empty string here would compare against it and win, which
  -- is the same answer by luck rather than by rule.
  | some "earliestVisible" =>
    match str? j "today", int? j "days" with
    | some t, some d =>
      let shareFrom := str? j "shareFrom"
      match Verified.ApiWindow.earliestVisible t d shareFrom with
      | none => Json.mkObj [("value", Json.null)]
      | some s => Json.mkObj [("value", Json.str s)]
    | _, _ => err "earliestVisible: today, days required"
  | some "shareableDateRange" =>
    match str? j "today", int? j "daysBack" with
    | some t, some d =>
      match Verified.Share.shareableDateRange t d with
      | none => Json.mkObj [("value", Json.null)]
      | some (f, to) =>
        Json.mkObj [("value", Json.mkObj [("from", Json.str f), ("to", Json.str to)])]
    | _, _ => err "shareableDateRange: today, daysBack required"
  | some "sessionTtlMs" =>
    Json.mkObj
      [ ("value", Json.num Verified.Session.SESSION_TTL_MS)
      , ("cookieMaxAgeS", Json.num Verified.Session.SESSION_COOKIE_MAX_AGE_S)
      , ("cookieName", Json.str Verified.Session.SESSION_COOKIE_NAME) ]
  -- The day after `date`, for the half-open `[date, nextDay)` bound a single-day
  -- read uses.
  --
  -- ⚠ Through the civil calendar, so it rolls a month, a year and a leap day.
  -- The TypeScript uses `Date.setDate`, which does too; a host adding 86400
  -- seconds would agree with it on most days and not on a DST boundary.
  | some "nextDay" =>
    match str? j "date" with
    | some d =>
      match Verified.Civil.addDays d 1 with
      | none => err s!"nextDay: {d} is not YYYY-MM-DD"
      | some nx => Json.mkObj [("value", Json.str nx)]
    | none => err "nextDay: date required"
  -- How hard a phone should look for itself (#982).
  --
  -- ⚠ Takes the WHOLE pruned history, because the decision is about a
  -- trajectory rather than a fix. Coordinates cross as IEEE-754 bit patterns:
  -- the straightness ratio divides two haversine distances, and a re-rounded
  -- coordinate moves it across the walking threshold.
  --
  -- ⚠ Answers a CONCRETE profile every time, never "no change". The phone gets
  -- the full config on every fix and treats it as idempotent, which is what
  -- removes the need for anti-flap state that could be lost.
  | some "owntracksConfig" =>
    let fixes : List Verified.Owntracks.Fix :=
      match j.getObjVal? "history" with
      | .error _ => []
      | .ok v =>
        match v.getArr? with
        | .error _ => []
        | .ok arr => arr.toList.filterMap fun e =>
          match int? e "ts", str? e "latBits", str? e "lonBits" with
          | some ts, some la, some lo =>
            some { ts := ts
                 , lat := Float.ofBits la.toNat!.toUInt64
                 , lon := Float.ofBits lo.toNat!.toUInt64
                 , vel := (str? e "velBits").map (fun b => Float.ofBits b.toNat!.toUInt64)
                 , trigger := str? e "trigger"
                 , monitoringMode := int? e "monitoringMode" }
          | _, _, _ => none
    -- ⚠ The gate is evaluated HERE from the places, not passed in as a boolean.
    -- A host that computed it would own the "which places may we demote at"
    -- decision, which is exactly the one that costs a walk home when wrong.
    let places : List Verified.Owntracks.GatingPlace :=
      match j.getObjVal? "places" with
      | .error _ => []
      | .ok v =>
        match v.getArr? with
        | .error _ => []
        | .ok arr => arr.toList.filterMap fun e =>
          match str? e "latBits", str? e "lonBits", str? e "dwellBits", str? e "sleepBits" with
          | some la, some lo, some dw, some sl =>
            some { centroidLat := Float.ofBits la.toNat!.toUInt64
                 , centroidLon := Float.ofBits lo.toNat!.toUInt64
                 , avgDwellSec := Float.ofBits dw.toNat!.toUInt64
                 , sleepHours := Float.ofBits sl.toNat!.toUInt64 }
          | _, _, _, _ => none
    let atLongStay :=
      match fixes.getLast? with
      | none => false
      | some last => Verified.Owntracks.isLongStayLocation last.lat last.lon places
    let manualHold := (j.getObjVal? "manualHoldActive" >>= (·.getBool?)).toOption == some true
    let prev : Option Verified.Owntracks.Profile :=
      match str? j "prevProfile" with
      | some "transit-fast" => some .transitFast
      | some "transit" => some .transit
      | some "walking" => some .walking
      | some "stationary" => some .stationary
      | _ => none
    let signals := Verified.Owntracks.computeSignals fixes
    let profile := Verified.Owntracks.decideRemoteConfig signals prev atLongStay manualHold
    let (monitoring, interval) := Verified.Owntracks.configFor profile
    Json.mkObj
      [ ("profile", Json.str profile.name)
      , ("monitoring", Json.num monitoring)
      , ("moveModeLocatorInterval", match interval with
          | none => Json.null
          | some i => Json.num i) ]
  -- The two halves of `stationsOnLine`, split where the TypeScript splits it
  -- (#1075). The SQL between them is the host's: resolve the substring match
  -- against a cached name list HERE, fetch that geometry with an indexed
  -- `name IN (…)` there, then filter by proximity back here.
  --
  -- ⚠ The split is not stylistic. A leading-wildcard `LIKE '%base%'` cannot use
  -- the name index and scans every railway row; the TypeScript measured ~28 s
  -- per call that way, and one leg fanning fifty of them serially is where its
  -- 24-minute pathology came from. Handing the host an exact name list is what
  -- keeps the query indexed.
  | some "lineNamesMatching" =>
    match str? j "line", j.getObjVal? "allNames" with
    | some line, .ok v =>
      match v.getArr? with
      | .error e => err s!"lineNamesMatching: allNames: {e}"
      | .ok arr =>
        match arr.mapM (·.getStr?) with
        | .error e => err s!"lineNamesMatching: a name is not a string: {e}"
        | .ok names =>
          Json.mkObj [("value", Json.arr
            ((Verified.Geo.LineStations.lineNamesMatching line names).map Json.str))]
    | _, _ => err "lineNamesMatching: needs line and allNames"
  -- ⚠ ORDER IS PART OF THE ANSWER. Downstream journey resolution reads
  -- positional relationships out of this list, so a set-equal-but-reordered
  -- result is a DIFFERENT result — see the port's own note. The station array
  -- must reach here in the order the host read it.
  --
  -- ⚠ Coordinates cross as IEEE-754 bit patterns. The proximity test compares a
  -- computed distance against 300 m, and a re-rounded coordinate moves which
  -- stations a line is held to serve.
  | some "filterStationsByLineProximity" =>
    let stationsOf : Except String (Array Verified.Geo.LineStations.StationCandidate) := do
      let arr ← (← j.getObjVal? "stations").getArr?
      arr.mapM fun e => do
        let name ← (← e.getObjVal? "name").getStr?
        let lat ← (← e.getObjVal? "latBits").getStr?
        let lon ← (← e.getObjVal? "lonBits").getStr?
        pure { name
             , lat := Float.ofBits lat.toNat!.toUInt64
             , lon := Float.ofBits lon.toNat!.toUInt64 }
    let waysOf : Except String (Array Verified.Geo.LineStations.WayGeometry) := do
      let arr ← (← j.getObjVal? "ways").getArr?
      arr.mapM fun w => do
        let cs ← w.getArr?
        let coords ← cs.mapM fun c => do
          let pair ← c.getArr?
          match pair[0]? >>= (·.getStr?.toOption), pair[1]? >>= (·.getStr?.toOption) with
          | some la, some lo =>
            pure (Float.ofBits la.toNat!.toUInt64, Float.ofBits lo.toNat!.toUInt64)
          | _, _ => throw "a way vertex is not two bit-pattern strings"
        pure { coords }
    match stationsOf, waysOf with
    | .error e, _ => err s!"filterStationsByLineProximity: stations: {e}"
    | _, .error e => err s!"filterStationsByLineProximity: ways: {e}"
    | .ok stations, .ok ways =>
      Json.mkObj [("value", Json.arr
        ((Verified.Geo.LineStations.filterStationsByLineProximity stations ways).map fun st =>
          Json.mkObj
            [ ("name", Json.str st.name)
            , ("latBits", Json.str (toString st.lat.toBits))
            , ("lonBits", Json.str (toString st.lon.toBits)) ]))]
  -- One day's decoded segments rolled up into a `presence_log` row (#982,
  -- Tier 2). The first CronJob's logic to move off node.
  --
  -- ⚠ ORDER IS PART OF THE ANSWER. A tie on minutes keeps the place seen FIRST,
  -- because the TypeScript accumulates into a `Map` and JS iterates one in
  -- insertion order. The segment array must arrive in the order the decoder
  -- emitted it, and the host must not sort it on the way here.
  | some "presenceRow" =>
    let segsOf : Except String (List Verified.PresenceLog.Segment) := do
      let arr ← (← j.getObjVal? "segments").getArr?
      (arr.mapM fun (e : Json) => do
        let startTs ← (← e.getObjVal? "startTs").getInt?
        let endTs ← (← e.getObjVal? "endTs").getInt?
        let mode ← (← e.getObjVal? "mode").getStr?
        -- ⚠ ABSENT and NULL both mean "no mined place", and neither is an
        -- error: `placeId` is null for every non-stationary segment, which is
        -- most of them.
        let placeId : Option Int := match e.getObjVal? "placeId" with
          | .ok v => (v.getInt?).toOption
          | .error _ => none
        pure ({ startTs, endTs, mode, placeId } : Verified.PresenceLog.Segment)).map Array.toList
    match segsOf with
    | .error e => err s!"presenceRow: segments: {e}"
    | .ok segs =>
      match Verified.PresenceLog.computeRow segs with
      -- ⚠ NO ROW is a legitimate answer, not a failure: a day that decoded
      -- nothing, or whose segments all round to zero minutes, is omitted rather
      -- than written as a row claiming 0% of nothing.
      | none => Json.mkObj [("value", Json.null)]
      | some r =>
        Json.mkObj
          [ ("value", Json.mkObj
              [ ("dominantPlaceId", match r.dominantPlaceId with
                  | none => Json.null | some i => Lean.toJson i)
              , ("dominantFractionBits", Json.str (toString r.dominantFraction.toBits))
              , ("endOfDayPlaceId", match r.endOfDayPlaceId with
                  | none => Json.null | some i => Lean.toJson i)
              , ("endOfDayTs", match r.endOfDayTs with
                  | none => Json.null | some i => Lean.toJson i)
              , ("endOfDayPosteriorBits", Json.str (toString r.endOfDayPosterior.toBits)) ]) ]
  -- The venues near a stay (#982, and the gap that blocked the cutover).
  --
  -- ⚠ This is what puts a VENUE NAME on a timeline instead of a bare
  -- "stationary". While the host declined this table, four venue names per day
  -- silently vanished from the served answer — measured against production
  -- 2026-08-23 before the arm existed.
  --
  -- ⚠ Distances cross as IEEE-754 bit patterns: the enclosing-institution rule
  -- compares one against 80 m, and a re-rounded value moves that boundary.
  | some "shapeLandmarks" =>
    -- ⚠ A TAG PAIR IS A TWO-ELEMENT ARRAY, `["amenity", "restaurant"]`. That is
    -- what `ServeEntry.tagsJson` writes, and reading it as a `{k, v}` OBJECT
    -- parses every pair to nothing. A feature with no tags spawns no landmark,
    -- so this op then answers `[]` for every stay — which CLAIMS "no venues
    -- here" instead of failing. It did exactly that: measured 2026-08-23 on
    -- 2026-05-22, all six `nearbyLandmarks` asks answered and all six empty,
    -- costing two venue names on the day while every count read as answered
    -- (#1054).
    --
    -- So a pair that does not parse is an ERROR, not an empty tag list. The two
    -- spellings are both well-formed JSON and neither side can detect the other
    -- by shape, which is precisely why this must not degrade quietly.
    let pairOf (pair : Json) : Except String (String × String) := do
      let kv ← pair.getArr?
      match kv[0]? >>= (·.getStr?.toOption), kv[1]? >>= (·.getStr?.toOption) with
      | some kk, some vv => pure (kk, vv)
      | _, _ => throw "shapeLandmarks: a tag pair is not two strings"
    let featuresOf (k : String) : Except String (List Verified.Geo.Landmarks.Feature) := do
      match j.getObjVal? k with
      | .error _ => pure []
      | .ok v =>
        let arr ← v.getArr?
        (arr.toList.filterMap fun e => (str? e "distBits").map ((e, ·)))
          |>.mapM fun (e, db) => do
            let tags ← match e.getObjVal? "tags" with
              | .error _ => pure []
              | .ok tv => do (← tv.getArr?).toList.mapM pairOf
            pure { name := str? e "name"
                 , tags
                 , distanceM := Float.ofBits db.toNat!.toUInt64
                 , encloses := (e.getObjVal? "encloses" >>= (·.getBool?)).toOption == some true
                 , isPoint := (e.getObjVal? "isPoint" >>= (·.getBool?)).toOption == some true }
    match (do
        pure (Verified.Geo.Landmarks.shapeLandmarks
          (← featuresOf "points") (← featuresOf "lines"))) with
    | .error e => err e
    | .ok ls =>
    Json.mkObj
      [ ("value", Json.arr (ls.map fun l =>
          Json.mkObj
            [ ("name", Json.str l.name)
            , ("type", Json.str l.type_)
            , ("subtype", Json.str l.subtype)
            , ("distanceMBits", Json.str (toString l.distanceM.toBits))
            , ("enclosing", Json.bool l.enclosing)
            , ("openingHours", match l.openingHours with
                | none => Json.null
                | some h => Json.str h) ]).toArray) ]
  -- The place picker's projection of one focus place (#982).
  --
  -- ⚠ `label` and `named` are DIFFERENT questions. A bare "Stay" gets a label
  -- (so the row renders) but is not `named` (so a picker can hide it): several
  -- Stays are indistinguishable to a person choosing one.
  -- The focus cron's amenity vote for ONE cluster (#982 Tier 2).
  --
  -- ⚠ Landmarks arrive in `shapeLandmarks`' OUTPUT shape, so the shell hands
  -- back what it already fetched rather than re-deriving it — including the raw
  -- `openingHours` tag, which `toLandmark` resolves against this stay's
  -- `samples`. Resolving hours shell-side would be a second implementation of
  -- `Verified.Geo.OpeningHours` living in Rust.
  --
  -- ⚠ The CENTROID's landmarks are resolved with `hasStay := false`: the
  -- centroid is a place, not an interval, so it has no window to be open
  -- during. The centroid gate asks only "is this a label-worthy venue here",
  -- which reads neither hours nor `openFraction`.
  -- The venue-type prior, mined from every cluster's attributed stays (#982).
  --
  -- ⚠ A FULL RECOMPUTE, never incremental — the cron rebuilds the blob from
  -- scratch on every run so that a re-mine after a gate change is reproducible.
  --
  -- ⚠ The output object's KEY ORDER is first-seen order, because
  -- `Verified.Geo.VenuePrior.minePriors` accumulates into an insertion-ordered
  -- list and the TypeScript accumulates into a JS object, which is the same
  -- order for string keys. The blob lands in `venue_type_priors.priors_json` as
  -- TEXT, so two arms that agree on the numbers but not the order still write
  -- different rows and a byte comparison of the two would read as a mismatch.
  | some "minePriors" =>
    let stayOf (e : Json) : Except String Verified.Geo.VenuePrior.AttributedStay := do
      let sub ← match str? e "subtype" with
        | some s => pure s
        | none => throw "minePriors: a stay has no subtype"
      let dur ← match str? e "durationSecBits" with
        | some s => pure (Float.ofBits s.toNat!.toUInt64)
        | none => throw "minePriors: a stay has no durationSecBits"
      let lh ← match int? e "localHour" with
        | some i => pure i
        | none => throw "minePriors: a stay has no localHour"
      pure { subtype := sub, durationSec := dur, localHour := lh }
    let statsJson (s : Verified.Geo.VenuePrior.VenueTypeStats) : Json :=
      Json.mkObj
        [ ("visits", Json.str (toString s.visits.toBits))
        , ("dwell", Json.arr ((s.dwell.map (fun x => Json.str (toString x.toBits))).toArray))
        , ("hours", Json.arr ((s.hours.map (fun x => Json.str (toString x.toBits))).toArray)) ]
    let tableJson (t : List (String × Verified.Geo.VenuePrior.VenueTypeStats)) : Json :=
      Json.arr ((t.map fun (k, s) => Json.arr #[Json.str k, statsJson s]).toArray)
    match (do
        let stays ← (← (← j.getObjVal? "attributed").getArr?).toList.mapM stayOf
        pure (Verified.Geo.VenuePrior.minePriors stays)) with
    | .error e => err e
    | .ok p =>
      Json.mkObj
        [ ("value", Json.mkObj
            [ ("bySubtype", tableJson p.bySubtype)
            , ("byCategory", tableJson p.byCategory)
            , ("totalVisitsBits", Json.str (toString p.totalVisits.toBits)) ]) ]
  -- Raw OSM rows → the `{edges, nodes}` the assemble modes consume (#982).
  --
  -- ⚠ The shell parses WKT and reads tag JSON — format concerns — and decides
  -- NOTHING. `isUnderground`, `parseLineMemberships`, the 5-dp `nodeKey` that
  -- fuses two ways meeting at a junction into ONE node, and the 150 m station
  -- merge are all below.
  | some "buildWireGraph" =>
    -- ⚠ Floats cross as IEEE-754 bit patterns in decimal strings, as everywhere
    -- else here. A coordinate re-rounded on the wire moves a node's 5-dp key,
    -- which is its IDENTITY — two ways that met at a junction would stop fusing.
    let jb (v : Json) : Except String Float :=
      match v.getStr? with
      | .ok s => pure (Float.ofBits s.toNat!.toUInt64)
      | .error _ => throw "buildWireGraph: a float is not a bit-pattern string"
    let fb (x : Float) : Json := Json.str (toString x.toBits)
    let latLonOf (e : Json) : Except String Verified.Hsmm.RouteGraph.LatLon := do
      let a ← e.getArr?
      match a[0]? , a[1]? with
      | some la, some lo => pure ⟨← jb la, ← jb lo⟩
      | _, _ => throw "buildWireGraph: a coordinate is not [latBits, lonBits]"
    let tagsOf (e : Json) : Except String (List (String × String)) :=
      match e.getObjVal? "tags" with
      | .error _ => pure []
      | .ok tv => do
        (← tv.getArr?).toList.mapM fun pair => do
          let kv ← pair.getArr?
          match kv[0]? >>= (·.getStr?.toOption), kv[1]? >>= (·.getStr?.toOption) with
          | some k, some v => pure (k, v)
          | _, _ => throw "buildWireGraph: a tag pair is not two strings"
    let wayOf (e : Json) : Except String Verified.Hsmm.RouteGraph.RawWay := do
      let geom ← (← (← e.getObjVal? "geometry").getArr?).toList.mapM latLonOf
      pure { id := ← (← e.getObjVal? "id").getStr?
           , geometry := geom
           , name := str? e "name"
           , subtype := str? e "subtype"
           , tags := ← tagsOf e }
    let stopOf (e : Json) : Except String Verified.Hsmm.RouteGraph.RawStop := do
      pure { lat := ← jb (← e.getObjVal? "latBits")
           , lon := ← jb (← e.getObjVal? "lonBits")
           , name := str? e "name"
           , tags := ← tagsOf e }
    match (do
        let ways ← (← (← j.getObjVal? "ways").getArr?).toList.mapM wayOf
        let stops ← (← (← j.getObjVal? "stops").getArr?).toList.mapM stopOf
        pure (Verified.Hsmm.RouteGraph.buildWireGraph ways stops)) with
    | .error e => err e
    | .ok (edges, nodes) =>
      Json.mkObj
        [ ("edges", Json.arr (edges.map fun e =>
            Json.mkObj
              [ ("id", Json.str e.id)
              , ("geometry", Json.arr ((e.geometry.map fun p =>
                  Json.mkObj [("lat", fb p.lat), ("lon", fb p.lon)]).toArray))
              , ("lineMemberships", Json.arr ((e.lineMemberships.map Json.str).toArray))
              , ("underground", Json.bool e.underground)
              , ("startNode", Json.str e.startNode)
              , ("endNode", Json.str e.endNode) ]))
        , ("nodes", Json.arr (nodes.map fun n =>
            Json.mkObj
              [ ("id", Json.str n.id)
              , ("lat", fb n.lat), ("lon", fb n.lon)
              , ("stationName", match n.stationName with
                  | none => Json.null | some s => Json.str s)
              , ("edgeIds", Json.arr ((n.edgeIds.map Json.str).toArray)) ])) ]
  | some "mineCluster" =>
    let poiOf (e : Json) : Except String Verified.Geo.BestPlace.Poi := do
      let need (k : String) : Except String String :=
        match str? e k with
        | some s => pure s
        | none => throw s!"mineCluster: a landmark has no {k}"
      let nm ← need "name"
      let ty ← need "type"
      let sub ← need "subtype"
      -- ⚠ THE FIELD IS `distanceM`, AND IT IS A BIT-PATTERN STRING. The Rust
      -- `shape_landmarks` wrapper REMAPS `shapeLandmarks`' own `distanceMBits`
      -- onto this name, because `DayEntry.parsePoi` and the trace-fed fold both
      -- read it as `distanceM` with `jBits`. Reading `distanceMBits` here found
      -- nothing and refused every landmark — measured against production on
      -- 2026-08-24, after the cluster half had already answered correctly.
      let db ← need "distanceM"
      pure { name := nm, type := ty, subtype := sub
           , distanceM := Float.ofBits db.toNat!.toUInt64
           , openingHours := str? e "openingHours"
           , enclosing := (e.getObjVal? "enclosing" >>= (·.getBool?)).toOption == some true }
    let poisOf (v : Json) : Except String (List Verified.Geo.BestPlace.Poi) := do
      (← v.getArr?).toList.mapM poiOf
    let sampleOf (e : Json) : Except String (Nat × Nat) := do
      let a ← e.getArr?
      match a[0]?, a[1]? with
      | some d, some m => pure ((← d.getNat?), (← m.getNat?))
      | _, _ => throw "mineCluster: a sample is not [dayOfWeek, minuteOfDay]"
    let bitsOf (k : String) : Except String Float :=
      match str? j k with
      | some s => pure (Float.ofBits s.toNat!.toUInt64)
      | none => throw s!"mineCluster: no {k}"
    let intOf (e : Json) (k : String) : Except String Int :=
      match int? e k with
      | some i => pure i
      | none => throw s!"mineCluster: a stay has no {k}"
    let stayOf (e : Json) : Except String Verified.Geo.FocusMining.MinedStay := do
      let samples ← (← (← e.getObjVal? "samples").getArr?).toList.mapM sampleOf
      let pois ← poisOf (← e.getObjVal? "landmarks")
      let st ← intOf e "startTs"
      let en ← intOf e "endTs"
      let lh ← intOf e "localHour"
      let dur ← intOf e "durationSec"
      pure { shape := { startUnix := st, endUnix := en, localHour := lh }
           , durationSec := dur
           , landmarks := pois.map (Verified.Geo.BestPlace.toLandmark samples true) }
    match (do
        let stays ← (← (← j.getObjVal? "stays").getArr?).toList.mapM stayOf
        let centroid ← poisOf (← j.getObjVal? "centroidLandmarks")
        let minWeight ← bitsOf "minWeightBits"
        let minFraction ← bitsOf "minFractionBits"
        pure (Verified.Geo.FocusMining.mineCluster stays
                (centroid.map (Verified.Geo.BestPlace.toLandmark [] false))
                minWeight minFraction)) with
    | .error e => err e
    | .ok m =>
      Json.mkObj
        [ ("value", Json.mkObj
            [ ("amenityLabel", optStr m.label)
            , ("amenityKind", optStr m.kind)
            , ("refusal", optStr (m.refusal.map (·.name)))
            , ("attributed", Json.arr ((m.attributed.map fun a =>
                Json.mkObj
                  [ ("subtype", Json.str a.subtype)
                  , ("durationSecBits", Json.str (toString a.durationSec.toBits))
                  , ("localHour", Lean.toJson a.localHour) ]).toArray)) ]) ]
  | some "placeProjection" =>
    let dn := str? j "displayName"
    let al := str? j "amenityLabel"
    Json.mkObj
      [ ("label", Json.str (Verified.Geo.CurrentPlace.placeLabel dn al))
      , ("named", Json.bool (Verified.Geo.CurrentPlace.isNamedPlace dn al))
      , ("category", match str? j "amenityKind" with
          | none => Json.null
          | some k => Json.str (Verified.Geo.VenuePrior.categoryOfSubtype k)) ]
  -- Which mined place is the user standing in?
  --
  -- ⚠ NEAREST within the radius, not highest-ranked. Coordinates cross as
  -- IEEE-754 bit patterns for the same reason the Kalman mode uses them: the
  -- seventh decimal of a fix moves the answer.
  | some "pickCurrentPlace" =>
    match str? j "latBits", str? j "lonBits" with
    | some la, some lo =>
      let places : Array Verified.Geo.CurrentPlace.FocusPlaceForPresence :=
        match j.getObjVal? "places" with
        | .error _ => #[]
        | .ok v =>
          match v.getArr? with
          | .error _ => #[]
          | .ok arr => arr.filterMap fun e =>
            match int? e "id", str? e "latBits", str? e "lonBits" with
            | some i, some pla, some plo =>
              some { id := i
                   , displayName := str? e "displayName"
                   , amenityLabel := str? e "amenityLabel"
                   , centroidLat := Float.ofBits pla.toNat!.toUInt64
                   , centroidLon := Float.ofBits plo.toNat!.toUInt64 }
            | _, _, _ => none
      match Verified.Geo.CurrentPlace.pickCurrentPlace
              (Float.ofBits la.toNat!.toUInt64) (Float.ofBits lo.toNat!.toUInt64) places with
      | none => Json.mkObj [("value", Json.null)]
      | some cp =>
        Json.mkObj
          [ ("value", Json.mkObj
              [ ("id", Json.num cp.id)
              , ("label", Json.str cp.label)
              , ("displayName", match cp.displayName with | none => Json.null | some d => Json.str d)
              , ("amenityLabel", match cp.amenityLabel with | none => Json.null | some a => Json.str a)
              , ("centroidLatBits", Json.str (toString cp.centroidLat.toBits))
              , ("centroidLonBits", Json.str (toString cp.centroidLon.toBits))
              , ("distanceMBits", Json.str (toString cp.distanceM.toBits)) ]) ]
    | _, _ => err "pickCurrentPlace: latBits, lonBits required"
  -- The raw recovery picture for one morning (#982).
  --
  -- ⚠ Answers NUMBERS, never a readiness score. Coach owns that judgment; two
  -- apps scoring it would drift on what a bad day is.
  --
  -- ⚠ Floats cross as IEEE-754 BIT PATTERNS in decimal strings, the convention
  -- `ServeEntry` documents: `Lean.JsonNumber` is a decimal that prints six
  -- places, so a JSON number here would re-round every value on the way out.
  | some "recoveryAsOf" =>
    match str? j "day" with
    | some day =>
      let series (k : String) : List Verified.Recovery.Daily :=
        match j.getObjVal? k with
        | .error _ => []
        | .ok v =>
          match v.getArr? with
          | .error _ => []
          | .ok arr => arr.toList.filterMap fun e =>
            match str? e "date" with
            | none => none
            | some dt =>
              let val := match e.getObjVal? "value" with
                | .error _ => none
                | .ok x => if x.isNull then none else (x.getNum?.toOption.map (·.toFloat))
              some { date := dt, value := val }
      let statOf (k : String) : Option Verified.Recovery.Stat :=
        Verified.Recovery.latestAndBaseline (Verified.Recovery.withinBaseline (series k) day)
      let statJson (st : Option Verified.Recovery.Stat) : Json :=
        match st with
        | none => Json.null
        | some v =>
          Json.mkObj
            [ ("latestBits", Json.str (toString v.latest.toBits))
            , ("meanBits", Json.str (toString v.mean.toBits))
            , ("sdBits", Json.str (toString v.sd.toBits))
            , ("n", Json.num v.n) ]
      let sleep := statOf "sleep"
      Json.mkObj
        [ ("asOf", Json.str day)
        , ("sleepHoursBits", match sleep with
            | none => Json.null
            | some v => Json.str (toString v.latest.toBits))
        , ("hrv", statJson (statOf "hrv"))
        , ("restingHr", statJson (statOf "rhr")) ]
    | none => err "recoveryAsOf: day required"
  -- ⚠ A REFUSAL, not a truncation: answering a decade-wide request with 400
  -- days would look complete to a caller who asked for more.
  | some "recoverySpan" =>
    match str? j "from", str? j "to" with
    | some f, some t =>
      Json.mkObj [("value", Json.bool (Verified.Recovery.spanIsAnswerable f t))]
    | _, _ => err "recoverySpan: from, to required"
  -- The post-login redirect target (#982).
  --
  -- ⚠ An OPEN-REDIRECT guard. Anything not clearly an internal path answers
  -- "/", so the caller can redirect unconditionally rather than carrying a
  -- branch someone might forget.
  | some "validateReturnTo" =>
    Json.mkObj [("value", Json.str (Verified.Login.validateReturnTo (str? j "returnTo")))]
  -- The pending-login cookie's payload.
  | some "encodePending" =>
    match int? j "expiresAt", str? j "nonce" with
    | some e, some n =>
      Json.mkObj [("value", Json.str (Verified.Login.encodePending e n (str? j "returnTo")))]
    | _, _ => err "encodePending: expiresAt, nonce required"
  | some "decodePending" =>
    match str? j "raw" with
    | some raw =>
      match Verified.Login.decodePending raw with
      | none => Json.mkObj [("value", Json.null)]
      | some (e, n, rt) =>
        Json.mkObj
          [ ("value", Json.mkObj
              [ ("expiresAt", Json.num e)
              , ("nonce", Json.str n)
              , ("returnTo", match rt with | none => Json.null | some r => Json.str r) ]) ]
    | none => err "decodePending: raw required"
  -- ⚠ `state` absent means Nextcloud DROPPED it, which is normal for a
  -- cookie-less browser and must still complete the login. Present-and-wrong is
  -- a refusal.
  | some "acceptPending" =>
    match int? j "expiresAt", str? j "nonce", int? j "nowMs" with
    | some e, some n, some now =>
      Json.mkObj [("value", Json.bool (Verified.Login.acceptPending e n (str? j "state") now))]
    | _, _, _ => err "acceptPending: expiresAt, nonce, nowMs required"
  | some "pendingTtlMs" =>
    Json.mkObj [("value", Json.num Verified.Login.PENDING_TTL_MS)]
  -- The PhoneTrack filter's start date (#982).
  --
  -- ⚠ `hour` must be the LOCAL hour and `(y, m, d)` the LOCAL date. Lean has no
  -- zone database, so the host resolves them; passing UTC parts would shift the
  -- 06:00 boundary by the offset.
  | some "phonetrackDatemin" =>
    match int? j "y", int? j "m", int? j "d", int? j "hour" with
    | some y, some m, some d, some h =>
      Json.mkObj [("value", Json.str (Verified.PhoneTrackPrefs.dateminDate y m d h))]
    | _, _, _, _ => err "phonetrackDatemin: y, m, d, hour required"
  -- Flatten client text into one log field (#982).
  --
  -- ⚠ A SECURITY BOUNDARY, not formatting. `/api/telemetry` writes this into a
  -- log line, so a newline in the input forges further lines attributed to
  -- someone else. A host that skipped this call would make the log unusable as
  -- evidence exactly when it matters.
  | some "oneLine" =>
    match str? j "raw", int? j "max" with
    | some raw, some max =>
      Json.mkObj [("value", Json.str (Verified.LogLine.oneLine raw max.toNat))]
    | _, _ => err "oneLine: raw, max required"
  -- The public share URL for a token (#982).
  | some "buildShareUrl" =>
    match str? j "baseUrl", str? j "token" with
    | some b, some t => Json.mkObj [("value", Json.str (Verified.Share.buildShareUrl b t))]
    | _, _ => err "buildShareUrl: baseUrl, token required"
  -- ⚠ CLAMPS. The mirror of `validateDays`, which REJECTS — two day-windows in
  -- one API with opposite behaviour, and both are the TypeScript's. `null` here
  -- means the value was not a finite number at all, NOT that it was out of
  -- range; out of range is silently narrowed.
  | some "clampShareDaysBack" =>
    match Verified.Share.clampShareDaysBack (optInt? j "daysBack") with
    | none => Json.mkObj [("value", Json.null)]
    | some n => Json.mkObj [("value", Json.num n)]
  -- Whether a linked account is working (#982).
  --
  -- ⚠ `stored` absent means NO ROW, which is `not_linked`. A host that sent an
  -- empty string for a missing row would get `active` back — the fall-through —
  -- and report a connection that does not exist as fine.
  | some "connectionStatus" =>
    let st := Verified.Connection.statusOf (str? j "stored")
    Json.mkObj
      [ ("value", Json.str (Verified.Connection.Status.toString st))
      , ("linked", Json.bool (Verified.Connection.isLinked st)) ]
  -- The day BEFORE `date`. `/location/latest` and `/location/tail` fetch
  -- yesterday as well as today so a fix just after midnight is not the only
  -- point in the window.
  | some "prevDay" =>
    match str? j "date" with
    | some d =>
      match Verified.Civil.addDays d (-1) with
      | none => err s!"prevDay: {d} is not YYYY-MM-DD"
      | some pv => Json.mkObj [("value", Json.str pv)]
    | none => err "prevDay: date required"
  -- The live-map constants (#982).
  | some "locationPolicy" =>
    Json.mkObj
      [ ("tailMaxPoints", Json.num Verified.LocationTail.TAIL_MAX_POINTS)
      , ("latestFixTtlMs", Json.num Verified.LocationTail.LATEST_FIX_TTL_MS)
      , ("tailTtlMs", Json.num Verified.LocationTail.TAIL_TTL_MS) ]
  -- ⚠ The REFERENCE tail, for the host's drift test only. The serving path
  -- filters inline — a tail buffer is thousands of points and shipping them all
  -- across the FFI per poll would cost more than the fetch it saves.
  | some "tailAfter" =>
    match ints? j "tss", int? j "since" with
    | some tss, some since =>
      Json.mkObj
        [ ("value", Json.arr ((Verified.LocationTail.tailAfter tss since).map (fun t => Json.num (Lean.JsonNumber.fromInt t))).toArray) ]
    | _, _ => err "tailAfter: tss, since required"
  -- The wire shape of a `selectAll()` row (#982).
  --
  -- ⚠ Asked ONCE PER COLUMN of a result set, not per value: the shape is a
  -- property of the column type. `null` in the answer means REFUSE THE REQUEST,
  -- not "render it as null" — an unmapped type is one whose rendering nobody
  -- has checked, and guessing produces a well-formed response of the wrong type.
  | some "rowShapes" =>
    match strs? j "types" with
    | some ts =>
      Json.mkObj
        [ ("value", Json.arr (ts.map fun t =>
            match Verified.RowShape.shapeOf t with
            | none => Json.null
            | some s => Json.str (shapeTag s)).toArray) ]
    | none => err "rowShapes: types required"
  -- The ISO rendering of a date/datetime column.
  --
  -- ⚠ The HOST formats these on the serving path — a day of intraday heart rate
  -- is thousands of values and a call each would be thousands of round trips.
  -- This op exists so `tests/row_shape.rs` can hold the host's formatter against
  -- this one over a corpus. If the two ever disagree, LEAN IS RIGHT.
  | some "formatIso" =>
    match ints? j "parts" with
    | some [y, m, d] => Json.mkObj [("value", Json.str (Verified.RowShape.formatDateIso y m d))]
    | some [y, m, d, h, mi, s, ms] =>
      Json.mkObj [("value", Json.str (Verified.RowShape.formatDateTimeIso y m d h mi s ms))]
    | _ => err "formatIso: parts must be [y,m,d] or [y,m,d,h,mi,s,ms]"
  | some other => err s!"unknown op: {other}"

@[export health_backend_call]
def backendCallExport (input : String) : String :=
  match Json.parse input with
  | .error e => (err s!"parse: {e}").compress
  | .ok j => (dispatch j).compress

end BackendEntry
