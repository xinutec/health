import Lean.Data.Json
import Verified.Civil
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
import Verified.Geo.OsmRegions
import Verified.Geo.OsmRouteMembers
import Verified.Geo.OsmMirrorRefresh
import Verified.Geo.OsmRailStops
import Verified.Geo.OsmBusRoutes
import Verified.Geo.OverpassBreaker
import Verified.Geo.FocusMining
import Verified.Hsmm.RouteGraph
import Verified.Session
import Verified.Share
import Verified.VelocityCache

/-!
# The backend's C ABI entry point

`rust/backend` links this as `rust/day-shell` links `DayEntry`, so the
decisions in `Verified.Session` and its siblings are called by the backend
rather than reimplemented beside it.

⚠ A `lean_lib`, not a `lean_exe`: an exe's root module emits `main`, and an
archive carrying `_main` silently wins the link in a foreign host, answering
from the wrong entry point.

String in, string out, as `DayEntry`: the narrowest C ABI that carries a
request, with no structs to keep in sync across three languages. These calls
are small enough that the JSON round trip is invisible beside the HTTP or
database work around them.

One dispatch rather than one export per function: one symbol to declare and
keep working across toolchain bumps, and a new decision costs only a `match`
arm.
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

/-- A required boolean field. -/
private def bool? (j : Json) (k : String) : Option Bool :=
  match j.getObjVal? k with
  | .ok v => match v.getBool? with | .ok b => some b | .error _ => none
  | .error _ => none

/-- `none` is a first-class answer here, not an error. -/
private def optStr : Option String → Json
  | none => Json.null
  | some s => Json.str s

/-- `[{"date": …, "grams": …, "ts": …}, …]`.

⚠ Every field is required, and a malformed element refuses the whole call: a
dropped weigh-in can move the `replaceFrom` boundary later, leaving stale
forward-filled rows it should have deleted. -/
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

⚠ A non-string element refuses the whole array: these are column type names,
and a skipped one would shift every later column onto the wrong shape. -/
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

def dispatch (j : Json) : Json :=
  match str? j "op" with
  | none => err "missing op"
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
  -- `/velocity`'s cache policy: the map and the in-flight dedup stay in the
  -- host; what crosses here is how long a result may be reused.
  --
  -- ⚠ `today` must be the viewer's local civil date, not UTC's; Lean has no
  -- zone database to check it (see `Verified.VelocityCache`).
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
  -- ⚠ Answers "is it in the window" only. A session with no share viewer must
  -- not reach this, or a missing window would admit the date.
  | some "dateInShareWindow" =>
    match str? j "date", str? j "from", str? j "to" with
    | some d, some f, some t =>
      Json.mkObj [("value", Json.bool (Verified.Share.dateInShareWindow d f t))]
    | _, _, _ => err "dateInShareWindow: date, from, to required"
  -- Session and share-viewer rules. The HMAC, the CSPRNG and the constant-time
  -- compare stay in the host.
  --
  -- `splitSigned` splits on the last separator: base64url has no `.`, so a
  -- value containing dots round-trips whole.
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
  -- ⚠ Answers "may this session do this", not "is there a session": `true` is
  -- not permission, and the caller's own session gate runs first.
  | some "mayProceed" =>
    match j.getObjVal? "isShareViewer" >>= (·.getBool?) |>.toOption,
          j.getObjVal? "hidesLocation" >>= (·.getBool?) |>.toOption,
          str? j "method", str? j "path" with
    | some sv, some hl, some m, some p =>
      Json.mkObj [("value", Json.bool (Verified.Session.mayProceedSharing sv hl m p))]
    | _, _, _, _ => err "mayProceed: isShareViewer, hidesLocation, method, path required"
  -- The multi-day API window.
  --
  -- ⚠ `days` is validated, not clamped: `null` out means reject the request,
  -- since a narrowed window would hide that the ask was impossible.
  --
  -- `days` follows JS `Number(...)`: absent is `null`, and an unparseable value
  -- is NaN, which JSON cannot carry, so the host sends `daysNaN: true` rather
  -- than letting it read as absent.
  | some "validateDays" =>
    let raw : Option Float :=
      if (j.getObjVal? "daysNaN" >>= (·.getBool?)).toOption == some true then some (0.0 / 0.0)
      else match j.getObjVal? "days" with
        | .error _ => none
        | .ok v => if v.isNull then none else (v.getNum?.toOption.map (·.toFloat))
    match Verified.ApiWindow.validateDays raw with
    | none => Json.mkObj [("value", Json.null)]
    | some n => Json.mkObj [("value", Json.num n)]
  -- `shareFrom` absent is the owner, bounded only by `days`; the host must not
  -- send the owner an empty string.
  | some "earliestVisible" =>
    match str? j "today", int? j "days" with
    | some t, some d =>
      let shareFrom := str? j "shareFrom"
      match Verified.ApiWindow.earliestVisible t d shareFrom with
      | none => Json.mkObj [("value", Json.null)]
      | some s => Json.mkObj [("value", Json.str s)]
    | _, _ => err "earliestVisible: today, days required"
  -- ⚠ `daysBack ≤ 0` and an unparsable `today` both answer null, which the
  -- caller must treat as "share disabled", not "no window".
  | some "shareableDateRange" =>
    match str? j "today", int? j "daysBack" with
    | some t, some d =>
      match Verified.Share.shareableDateRange t d with
      | none => Json.mkObj [("value", Json.null)]
      | some (f, to) =>
        Json.mkObj [("value", Json.mkObj [("from", Json.str f), ("to", Json.str to)])]
    | _, _ => err "shareableDateRange: today, daysBack required"
  | some "renewedExpiry" =>
    match int? j "expiresAtMs", int? j "nowMs" with
    | some e, some n =>
      match Verified.Session.renewedExpiry e n with
      | none => Json.mkObj [("value", Json.null)]
      | some v => Json.mkObj [("value", Json.num v)]
    | _, _ => err "renewedExpiry: expiresAtMs, nowMs required"
  | some "sessionTtlMs" =>
    Json.mkObj
      [ ("value", Json.num Verified.Session.SESSION_TTL_MS)
      , ("cookieMaxAgeS", Json.num Verified.Session.SESSION_COOKIE_MAX_AGE_S)
      , ("cookieName", Json.str Verified.Session.SESSION_COOKIE_NAME) ]
  -- The day after `date`, for the half-open `[date, nextDay)` bound of a
  -- single-day read. Through the civil calendar, so it rolls months, years and
  -- leap days; adding 86400 seconds would be wrong across DST.
  | some "nextDay" =>
    match str? j "date" with
    | some d =>
      match Verified.Civil.addDays d 1 with
      | none => err s!"nextDay: {d} is not YYYY-MM-DD"
      | some nx => Json.mkObj [("value", Json.str nx)]
    | none => err "nextDay: date required"
  -- How hard a phone should look for itself.
  --
  -- Takes the whole pruned history, since the decision is about a trajectory.
  -- ⚠ Coordinates cross as IEEE-754 bit patterns: the straightness ratio
  -- divides two haversine distances, and re-rounding moves it across the
  -- walking threshold.
  --
  -- Always a concrete profile, never "no change": the phone applies the full
  -- config idempotently on every fix, so there is no anti-flap state to lose.
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
    let prev : Option Verified.Owntracks.Profile :=
      match str? j "prevProfile" with
      | some "transit-fast" => some .transitFast
      | some "transit" => some .transit
      | some "walking" => some .walking
      | some "night" => some .night
      | _ => none
    let signals := { Verified.Owntracks.computeSignals fixes with localHour := int? j "localHour" }
    let profile := Verified.Owntracks.decideRemoteConfig signals prev
    let (monitoring, interval) := Verified.Owntracks.configFor profile
    Json.mkObj
      [ ("profile", Json.str profile.name)
      , ("monitoring", Json.num monitoring)
      , ("moveModeLocatorInterval", match interval with
          | none => Json.null
          | some i => Json.num i) ]
  -- The two halves of `stationsOnLine`, with the SQL between them in the host:
  -- resolve the substring match against a cached name list here, fetch that
  -- geometry with an indexed `name IN (…)` there, then filter by proximity.
  --
  -- ⚠ The split keeps the query indexed: a leading-wildcard `LIKE '%base%'`
  -- scans every railway row, ~28 s a call, and one leg can fan out fifty.
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
  -- ⚠ Order is part of the answer: journey resolution reads positions out of
  -- this list, so the stations must arrive in the order the host read them.
  --
  -- ⚠ Coordinates cross as IEEE-754 bit patterns: the proximity test compares
  -- a distance against 300 m, and re-rounding moves which stations qualify.
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
  -- One day's decoded segments rolled up into a `presence_log` row.
  --
  -- ⚠ Order is part of the answer: a tie on minutes keeps the place seen
  -- first, so the segments must arrive in the decoder's order, unsorted.
  | some "presenceRow" =>
    let segsOf : Except String (List Verified.PresenceLog.Segment) := do
      let arr ← (← j.getObjVal? "segments").getArr?
      (arr.mapM fun (e : Json) => do
        let startTs ← (← e.getObjVal? "startTs").getInt?
        let endTs ← (← e.getObjVal? "endTs").getInt?
        let mode ← (← e.getObjVal? "mode").getStr?
        -- Absent and null both mean "no mined place": `placeId` is null for
        -- every non-stationary segment.
        let placeId : Option Int := match e.getObjVal? "placeId" with
          | .ok v => (v.getInt?).toOption
          | .error _ => none
        pure ({ startTs, endTs, mode, placeId } : Verified.PresenceLog.Segment)).map Array.toList
    match segsOf with
    | .error e => err s!"presenceRow: segments: {e}"
    | .ok segs =>
      match Verified.PresenceLog.computeRow segs with
      -- No row is a legitimate answer: a day that decoded nothing, or whose
      -- segments all round to zero minutes, is omitted rather than written as
      -- 0% of nothing.
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
  -- The venues near a stay, which put a venue name on a timeline instead of a
  -- bare "stationary".
  --
  -- ⚠ Distances cross as IEEE-754 bit patterns: the enclosing-institution rule
  -- compares one against 80 m.
  | some "shapeLandmarks" =>
    -- ⚠ A tag pair is a two-element array, `["amenity", "restaurant"]`, as
    -- `ServeEntry.tagsJson` writes it. Read as a `{k, v}` object every pair
    -- parses to nothing, no feature spawns a landmark, and every stay answers
    -- `[]`, claiming "no venues here" while every count reads as answered.
    -- Neither spelling can be told from the other by shape, so a pair that
    -- does not parse is an error.
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
            , ("inside", Json.bool l.inside)
            , ("openingHours", match l.openingHours with
                | none => Json.null
                | some h => Json.str h) ]).toArray) ]
  -- The venue-type prior, mined from every cluster's attributed stays.
  --
  -- A full recompute every run, so a re-mine after a gate change is
  -- reproducible.
  --
  -- ⚠ The output's key order is first-seen order. The blob is stored as TEXT
  -- in `venue_type_priors.priors_json`, so the same numbers in another order
  -- write a different row.
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
      -- ⚠ Required, not defaulted: a `startUnix` of 0 would make every stay
      -- 1970 evidence, and an as-of-the-day prior would include all of it.
      let su ← match int? e "startUnix" with
        | some i => pure i
        | none => throw "minePriors: a stay has no startUnix"
      pure { subtype := sub, durationSec := dur, localHour := lh, startUnix := su }
    let statsJson (s : Verified.Geo.VenuePrior.VenueTypeStats) : Json :=
      Json.mkObj
        [ ("visits", Json.str (toString s.visits.toBits))
        , ("dwell", Json.arr ((s.dwell.map (fun x => Json.str (toString x.toBits))).toArray))
        , ("hours", Json.arr ((s.hours.map (fun x => Json.str (toString x.toBits))).toArray)) ]
    let tableJson (t : List (String × Verified.Geo.VenuePrior.VenueTypeStats)) : Json :=
      Json.arr ((t.map fun (k, s) => Json.arr #[Json.str k, statsJson s]).toArray)
    let eventJson (e : Verified.Geo.VenuePrior.PriorEvent) : Json :=
      Json.mkObj
        [ ("subtype", Json.str e.subtype)
        , ("startUnix", Lean.toJson e.startUnix)
        , ("dwell", Lean.toJson e.dwell)
        , ("hour", Lean.toJson e.hour)
        , ("weightBits", Json.str (toString e.weight.toBits)) ]
    match (do
        let stays ← (← (← j.getObjVal? "attributed").getArr?).toList.mapM stayOf
        pure (stays, Verified.Geo.VenuePrior.minePriors stays)) with
    | .error e => err e
    | .ok (stays, p) =>
      Json.mkObj
        [ ("value", Json.mkObj
            [ ("bySubtype", tableJson p.bySubtype)
            , ("byCategory", tableJson p.byCategory)
            , ("totalVisitsBits", Json.str (toString p.totalVisits.toBits))
            -- The evidence rides alongside the aggregate, which stays: a
            -- stored blob must remain readable by code that has never heard
            -- of `events`, including the running pod during a rollout.
            , ("events", Json.arr
                ((Verified.Geo.VenuePrior.eventsOfAttributed stays).map eventJson).toArray) ]) ]
  -- The stored evidence, re-aggregated as it stood at the end of one day. The
  -- reply has `minePriors`' shape, so everything downstream is unchanged.
  --
  -- The cut is the caller's: the shell knows the day served and its zone, and
  -- `localHour` already arrives resolved.
  | some "priorsAsOf" =>
    let eventOf (e : Json) : Except String Verified.Geo.VenuePrior.PriorEvent := do
      let sub ← match str? e "subtype" with
        | some s => pure s
        | none => throw "priorsAsOf: an event has no subtype"
      let su ← match int? e "startUnix" with
        | some i => pure i
        | none => throw "priorsAsOf: an event has no startUnix"
      let dw ← match int? e "dwell" with
        | some i => pure i.toNat
        | none => throw "priorsAsOf: an event has no dwell"
      let hr ← match int? e "hour" with
        | some i => pure i.toNat
        | none => throw "priorsAsOf: an event has no hour"
      let w ← match str? e "weightBits" with
        | some s => pure (Float.ofBits s.toNat!.toUInt64)
        | none => throw "priorsAsOf: an event has no weightBits"
      pure { subtype := sub, startUnix := su, dwell := dw, hour := hr, weight := w }
    let statsJson' (s : Verified.Geo.VenuePrior.VenueTypeStats) : Json :=
      Json.mkObj
        [ ("visits", Json.str (toString s.visits.toBits))
        , ("dwell", Json.arr ((s.dwell.map (fun x => Json.str (toString x.toBits))).toArray))
        , ("hours", Json.arr ((s.hours.map (fun x => Json.str (toString x.toBits))).toArray)) ]
    let tableJson' (t : List (String × Verified.Geo.VenuePrior.VenueTypeStats)) : Json :=
      Json.arr ((t.map fun (k, s) => Json.arr #[Json.str k, statsJson' s]).toArray)
    match (do
        let events ← (← (← j.getObjVal? "events").getArr?).toList.mapM eventOf
        let cut ← match int? j "asOfUnix" with
          | some i => pure i
          | none => throw "priorsAsOf: no asOfUnix"
        pure (Verified.Geo.VenuePrior.priorsAsOf events cut)) with
    | .error e => err e
    | .ok p =>
      Json.mkObj
        [ ("value", Json.mkObj
            [ ("bySubtype", tableJson' p.bySubtype)
            , ("byCategory", tableJson' p.byCategory)
            , ("totalVisitsBits", Json.str (toString p.totalVisits.toBits)) ]) ]
  -- Raw OSM rows → the `{edges, nodes}` the assemble modes consume.
  --
  -- The shell parses WKT and tag JSON and decides nothing: `isUnderground`,
  -- `parseLineMemberships`, the 5-dp `nodeKey` that fuses ways meeting at a
  -- junction, and the 150 m station merge are all below.
  | some "buildWireGraph" =>
    -- ⚠ Floats cross as IEEE-754 bit patterns: a re-rounded coordinate moves a
    -- node's 5-dp key, its identity, and junctions stop fusing.
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
  -- The focus cron's amenity vote for one cluster.
  --
  -- Landmarks arrive in `shapeLandmarks`' output shape, including the raw
  -- `openingHours` tag, which `toLandmark` resolves against this stay's
  -- `samples`; resolving hours in Rust would be a second
  -- `Verified.Geo.OpeningHours`.
  --
  -- The centroid's landmarks are resolved with `hasStay := false`: a centroid
  -- has no interval to be open during, and its gate reads neither hours nor
  -- `openFraction`.
  | some "mineCluster" =>
    let poiOf (e : Json) : Except String Verified.Geo.BestPlace.Poi := do
      let need (k : String) : Except String String :=
        match str? e k with
        | some s => pure s
        | none => throw s!"mineCluster: a landmark has no {k}"
      let nm ← need "name"
      let ty ← need "type"
      let sub ← need "subtype"
      -- ⚠ The field is `distanceM`, a bit-pattern string: the Rust
      -- `shape_landmarks` wrapper renames `shapeLandmarks`' `distanceMBits` to
      -- it, because `DayEntry.parsePoi` and the trace-fed fold read that name.
      -- Reading `distanceMBits` here refused every landmark.
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
                  , ("localHour", Lean.toJson a.localHour)
                  -- A plain integer, not bits: a unix second the shell holds
                  -- as an integer, as with `zoom`.
                  , ("startUnix", Lean.toJson a.startUnix) ]).toArray)) ]) ]
  -- The place picker's projection of one focus place.
  --
  -- `label` and `named` differ: a bare "Stay" gets a label so the row renders,
  -- but is not `named`, so a picker can hide it; several Stays are
  -- indistinguishable to a person choosing one.
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
  -- Nearest within the radius, not highest-ranked. ⚠ Coordinates cross as
  -- IEEE-754 bit patterns: the seventh decimal of a fix moves the answer.
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
  -- The raw recovery picture for one morning.
  --
  -- Numbers, never a readiness score: coach owns that judgement, and two apps
  -- scoring it would drift.
  --
  -- ⚠ Floats cross as IEEE-754 bit patterns: `Lean.JsonNumber` prints six
  -- places, so a JSON number would re-round every value.
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
  -- A refusal, not a truncation: a decade-wide request answered with 400 days
  -- would look complete.
  | some "recoverySpan" =>
    match str? j "from", str? j "to" with
    | some f, some t =>
      Json.mkObj [("value", Json.bool (Verified.Recovery.spanIsAnswerable f t))]
    | _, _ => err "recoverySpan: from, to required"
  -- The post-login redirect target.
  --
  -- ⚠ An open-redirect guard: anything not clearly an internal path answers
  -- "/", so the caller redirects unconditionally.
  | some "validateReturnTo" =>
    Json.mkObj [("value", Json.str (Verified.Login.validateReturnTo (str? j "returnTo")))]
  -- The pending-login cookie's payload.
  | some "encodePending" =>
    match int? j "expiresAt", str? j "nonce", bool? j "retried" with
    | some e, some n, some r =>
      Json.mkObj [("value", Json.str (Verified.Login.encodePending e n r (str? j "returnTo")))]
    | _, _, _ => err "encodePending: expiresAt, nonce, retried required"
  | some "decodePending" =>
    match str? j "raw" with
    | some raw =>
      match Verified.Login.decodePending raw with
      | none => Json.mkObj [("value", Json.null)]
      | some (e, n, r, rt) =>
        Json.mkObj
          [ ("value", Json.mkObj
              [ ("expiresAt", Json.num e)
              , ("nonce", Json.str n)
              , ("retried", Json.bool r)
              , ("returnTo", match rt with | none => Json.null | some r => Json.str r) ]) ]
    | none => err "decodePending: raw required"
  -- `state` absent means Nextcloud dropped it, normal for a cookie-less
  -- browser: retried once, never accepted. Present and wrong is a refusal.
  | some "acceptPending" =>
    match int? j "expiresAt", str? j "nonce", bool? j "retried", int? j "nowMs" with
    | some e, some n, some r, some now =>
      Json.mkObj [("value", Json.str (Verified.Login.acceptPending e n r (str? j "state") now).name)]
    | _, _, _, _ => err "acceptPending: expiresAt, nonce, retried, nowMs required"
  | some "pendingTtlMs" =>
    Json.mkObj [("value", Json.num Verified.Login.PENDING_TTL_MS)]
  -- The PhoneTrack filter's start date.
  --
  -- ⚠ `hour` and `(y, m, d)` are local: Lean has no zone database, so the host
  -- resolves them, and UTC parts would shift the 06:00 boundary.
  | some "phonetrackDatemin" =>
    match int? j "y", int? j "m", int? j "d", int? j "hour" with
    | some y, some m, some d, some h =>
      Json.mkObj [("value", Json.str (Verified.PhoneTrackPrefs.dateminDate y m d h))]
    | _, _, _, _ => err "phonetrackDatemin: y, m, d, hour required"
  -- Flatten client text into one log field.
  --
  -- ⚠ A security boundary: `/api/telemetry` writes this into a log line, and a
  -- newline in the input would forge further lines.
  | some "oneLine" =>
    match str? j "raw", int? j "max" with
    | some raw, some max =>
      Json.mkObj [("value", Json.str (Verified.LogLine.oneLine raw max.toNat))]
    | _, _ => err "oneLine: raw, max required"
  -- The public share URL for a token.
  | some "buildShareUrl" =>
    match str? j "baseUrl", str? j "token" with
    | some b, some t => Json.mkObj [("value", Json.str (Verified.Share.buildShareUrl b t))]
    | _, _ => err "buildShareUrl: baseUrl, token required"
  -- ⚠ Clamps, where `validateDays` rejects. `null` here means the value was not
  -- a finite number; out of range is narrowed.
  | some "clampShareDaysBack" =>
    match Verified.Share.clampShareDaysBack (optInt? j "daysBack") with
    | none => Json.mkObj [("value", Json.null)]
    | some n => Json.mkObj [("value", Json.num n)]
  -- Whether a linked account is working.
  --
  -- ⚠ `stored` absent means no row, `not_linked`; an empty string would fall
  -- through to `active`.
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
  -- The live-map constants.
  | some "locationPolicy" =>
    Json.mkObj
      [ ("tailMaxPoints", Json.num Verified.LocationTail.TAIL_MAX_POINTS)
      , ("latestFixTtlMs", Json.num Verified.LocationTail.LATEST_FIX_TTL_MS)
      , ("tailTtlMs", Json.num Verified.LocationTail.TAIL_TTL_MS) ]
  -- The reference tail, for the host's drift test only: the serving path
  -- filters inline, since shipping thousands of tail points across the FFI per
  -- poll would cost more than the fetch.
  | some "tailAfter" =>
    match ints? j "tss", int? j "since" with
    | some tss, some since =>
      Json.mkObj
        [ ("value", Json.arr ((Verified.LocationTail.tailAfter tss since).map (fun t => Json.num (Lean.JsonNumber.fromInt t))).toArray) ]
    | _, _ => err "tailAfter: tss, since required"
  -- The wire shape of a `selectAll()` row, asked once per column.
  --
  -- ⚠ `null` means refuse the request, not render a null: an unmapped type's
  -- rendering has never been checked.
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
  -- The host formats these on the serving path (thousands of values a day);
  -- this op lets `tests/row_shape.rs` hold the host's formatter against it. If
  -- the two disagree, Lean is right.
  | some "formatIso" =>
    match ints? j "parts" with
    | some [y, m, d] => Json.mkObj [("value", Json.str (Verified.RowShape.formatDateIso y m d))]
    | some [y, m, d, h, mi, s, ms] =>
      Json.mkObj [("value", Json.str (Verified.RowShape.formatDateTimeIso y m d h mi s ms))]
    | _ => err "formatIso: parts must be [y,m,d] or [y,m,d,h,mi,s,ms]"
  -- The two Overpass mirrors' whole judgement: which region, which tiles,
  -- which relations, and whether the run may write. The shell does HTTP and
  -- SQL.
  --
  -- The raw Overpass response comes in here, so `Verified.Geo.Osm*` stays pure
  -- over its own types and there is one definition of an element, not a Rust
  -- parse narrowing a ~5 MB tile first.
  | some "mirrorRegion" =>
    -- Focus-place coordinates in, the home metro's tiles out. `points` are
    -- [latBits, lonBits] pairs; the cutoff that made them "recent" is the
    -- shell's, because it is a clock read.
    let jb (v : Json) : Except String Float :=
      match v.getStr? with
      | .ok s => pure (Float.ofBits s.toNat!.toUInt64)
      | .error _ => throw "mirrorRegion: a float is not a bit-pattern string"
    let fb (x : Float) : Json := Json.str (toString x.toBits)
    let ptOf (e : Json) : Except String Verified.Geo.OsmRegions.Pt := do
      let a ← e.getArr?
      match a[0]? , a[1]? with
      | some la, some lo => pure { lat := ← jb la, lon := ← jb lo }
      | _, _ => throw "mirrorRegion: a point is not [latBits, lonBits]"
    let run : Except String Json := do
      let pts ← (← (← j.getObjVal? "points").getArr?).mapM ptOf
      let gapKm ← jb (← j.getObjVal? "maxGapKmBits")
      let cellDeg ← jb (← j.getObjVal? "maxCellDegBits")
      let marginM ← jb (← j.getObjVal? "marginMBits")
      match Verified.Geo.OsmRegions.homeRegionBbox pts gapKm marginM with
      | none => pure (Json.mkObj [("value", Json.null)])
      | some b =>
        let tiles := Verified.Geo.OsmRegions.tileBbox b cellDeg
        let boxJson := fun (x : Verified.Geo.OsmRegions.Bbox) =>
          Json.mkObj [("minLat", fb x.minLat), ("maxLat", fb x.maxLat),
                      ("minLon", fb x.minLon), ("maxLon", fb x.maxLon)]
        pure (Json.mkObj
          [("value", Json.mkObj
            [ ("bbox", boxJson b)
            , ("regionCount", Json.num (Verified.Geo.OsmRegions.clusterIntoRegionIndices pts gapKm).size)
            , ("placeCount", Json.num pts.size)
            , ("tiles", Json.arr (tiles.map boxJson)) ])])
    match run with | .ok v => v | .error e => err e
  -- One tile's Overpass response, parsed and filtered. `mode` picks the arm;
  -- the two arms disagree about `ref` and about which tile's copy wins, and
  -- both disagreements are deliberate (see the module notes).
  | some "extractRoutes" =>
    let tagOf (e : Json) (k : String) : Option String :=
      match e.getObjVal? "tags" with | .ok t => str? t k | _ => none
    let natOf (e : Json) (k : String) : Option Nat :=
      match e.getObjVal? k with
      | .ok v => match v.getNat? with | .ok n => some n | _ => none
      | _ => none
    let fltOf (e : Json) (k : String) : Option Float :=
      match e.getObjVal? k with
      | .ok v => match v.getNum? with | .ok n => some n.toFloat | _ => none
      | _ => none
    let membersOf (e : Json) : Array Verified.Geo.OsmRouteMembers.Member :=
      match e.getObjVal? "members" with
      | .ok (.arr a) => a.map (fun m =>
          { type := str? m "type", ref := natOf m "ref", role := str? m "role" })
      | _ => #[]
    let fb (x : Float) : Json := Json.str (toString x.toBits)
    let stopJson := fun (s : Verified.Geo.OsmRouteMembers.RouteStop) =>
      -- Field order is name, lat, lon, seq; the shell keeps it when it renders
      -- the floats, so a re-fetched tile writes the same `stops_json`.
      Json.mkObj [("name", optStr s.name), ("lat", fb s.lat), ("lon", fb s.lon),
                  ("seq", Json.num s.seq)]
    let run : Except String Json := do
      let els ← (← j.getObjVal? "elements").getArr?
      let nodeOf (e : Json) : Option (Nat × Verified.Geo.OsmRouteMembers.ResolvedNode) :=
        if str? e "type" == some "node" then
          match natOf e "id", fltOf e "lat", fltOf e "lon" with
          | some id, some lat, some lon =>
            some (id, { lat := lat, lon := lon, name := tagOf e "name" })
          | _, _, _ => none
        else none
      let nodes := els.filterMap nodeOf
      let rels := els.filter (fun e => str? e "type" == some "relation")
      match str? j "mode" with
      | some "rail" =>
        let raw : Array Verified.Geo.OsmRailStops.RawRelation := rels.map (fun e =>
          { osmRelationId := (natOf e "id").getD 0, relType := tagOf e "type"
          , route := tagOf e "route", ref := tagOf e "ref", name := tagOf e "name"
          , members := membersOf e })
        pure (Json.mkObj [("value", Json.arr
          ((Verified.Geo.OsmRailStops.extractRailStopRelations raw nodes).map (fun r =>
            Json.mkObj
              [ ("osmRelationId", Json.num r.osmRelationId)
              , ("routeType", Json.str r.routeType)
              , ("lineRef", optStr r.lineRef)
              , ("lineName", optStr r.lineName)
              , ("stops", Json.arr (r.stops.map stopJson)) ])))])
      | some "bus" =>
        let raw : Array Verified.Geo.OsmBusRoutes.RawRelation := rels.map (fun e =>
          { osmRelationId := (natOf e "id").getD 0, relType := tagOf e "type"
          , route := tagOf e "route", ref := tagOf e "ref", name := tagOf e "name"
          , members := membersOf e })
        pure (Json.mkObj [("value", Json.arr
          ((Verified.Geo.OsmBusRoutes.extractBusRoutes raw nodes).map (fun r =>
            Json.mkObj
              [ ("osmRelationId", Json.num r.osmRelationId)
              , ("routeRef", Json.str r.routeRef)
              , ("routeName", optStr r.routeName)
              , ("stops", Json.arr (r.stops.map stopJson)) ])))])
      | _ => throw "extractRoutes: mode must be \"rail\" or \"bus\""
    match run with | .ok v => v | .error e => err e
  -- The Overpass QL for one tile. Coordinates arrive already rendered — see
  -- `buildRailStopsOverpassQuery`.
  | some "overpassQuery" =>
    match str? j "mode", str? j "minLat", str? j "minLon", str? j "maxLat", str? j "maxLon" with
    | some "rail", some a, some b, some c, some d =>
      Json.mkObj [("value", Json.str (Verified.Geo.OsmRailStops.buildRailStopsOverpassQuery a b c d))]
    | some "bus", some a, some b, some c, some d =>
      Json.mkObj [("value", Json.str (Verified.Geo.OsmBusRoutes.buildBusRouteOverpassQuery a b c d))]
    | _, _, _, _, _ => err "overpassQuery: mode and four rendered coordinates required"
  -- Is too much of a route mirror's area stale? Asked after the write: the
  -- tiles that answered are already stored, so this decides only whether the
  -- run fails (`Verified.Geo.OsmMirrorRefresh`).
  | some "mirrorStaleness" =>
    match int? j "existing", int? j "staleTiles", int? j "tilesTotal", int? j "staleDays" with
    | some existing, some stale, some total, some days =>
      let refusal := Verified.Geo.OsmMirrorRefresh.staleRefusal
        existing.toNat stale.toNat total.toNat days.toNat
      Json.mkObj [("value", Json.mkObj
        [("refusal", match refusal with | some why => Json.str why | none => Json.null)])]
    | _, _, _, _ => err "mirrorStaleness: existing, staleTiles, tilesTotal and staleDays are required"
  -- The circuit breaker, one step at a time. The clock is the shell's; the
  -- decision is not.
  | some "breaker" =>
    let stOf : Except String Verified.Geo.OverpassBreaker.State := do
      let s ← j.getObjVal? "state"
      let fs ← (← (← s.getObjVal? "failures").getArr?).mapM (fun v =>
        match v.getNat? with | .ok n => pure n | .error _ => throw "breaker: a failure stamp is not a Nat")
      match (← s.getObjVal? "openUntilMs").getNat? with
      | .ok o => pure { failures := fs, openUntilMs := o }
      | .error _ => throw "breaker: openUntilMs is not a Nat"
    let run : Except String Json := do
      let st ← stOf
      let now ← match (← j.getObjVal? "nowMs").getNat? with
        | .ok n => pure n | .error _ => throw "breaker: nowMs is not a Nat"
      let next := match str? j "event" with
        | some "failure" => Verified.Geo.OverpassBreaker.recordFailure st now
        | some "success" => Verified.Geo.OverpassBreaker.recordSuccess st now
        | _ => st
      pure (Json.mkObj [("value", Json.mkObj
        [ ("open", Json.bool (Verified.Geo.OverpassBreaker.isOpen next now))
        , ("state", Json.mkObj
            [ ("failures", Json.arr (next.failures.map (fun t => Json.num (t : Nat))))
            , ("openUntilMs", Json.num next.openUntilMs) ]) ])])
    match run with | .ok v => v | .error e => err e
  | some other => err s!"unknown op: {other}"

end BackendEntry
