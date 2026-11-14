/-!
# Session and share-viewer rules

The decisions in front of every authenticated request. The HMAC, the CSPRNG
and the constant-time compare are not here: there is nothing to prove about
them beyond that they were asked for.

Here: signed-cookie framing (split on the last separator), session expiry and
its boundary, and what a share recipient may do.

Pure and total. UNPROVEN; pinned by the `#guard`s, including the framing cases.
-/

namespace Verified.Session

/-- How long a session lasts unused: a month (the user's call). Every use moves
the expiry forward (`renewedExpiry`), so a forgotten browser stops working a
month after its last visit. -/
def SESSION_TTL_MS : Int := 30 * 24 * 60 * 60 * 1000

/-- The expiry is rewritten only when it would move by more than this, so a page
load is not a database write. -/
def RENEW_INTERVAL_MS : Int := 60 * 60 * 1000

/-- The cookie's `Max-Age`: 400 days, the most a browser keeps. The row decides
when a session ends; a cookie as short as the row would end a renewed session at
its first expiry. -/
def SESSION_COOKIE_MAX_AGE_S : Int := 400 * 24 * 60 * 60

/-- The renewed expiry of a session used at `nowMs`, or `none` when it would
move by `RENEW_INTERVAL_MS` or less. -/
def renewedExpiry (expiresAtMs nowMs : Int) : Option Int :=
  let fresh := nowMs + SESSION_TTL_MS
  if fresh - expiresAtMs > RENEW_INTERVAL_MS then some fresh else none

def SESSION_COOKIE_NAME : String := "session"

/-- Split a signed value into `(value, signature)`.

⚠ On the last separator: base64url has no `.`, so a value containing dots
round-trips. The first dot would truncate the value and fail closed, inviting a
"fix" that loosens the comparison.

`none` without a separator. `".sig"` splits to `("", "sig")` and fails at the
signature check. -/
def splitSigned (signed : String) : Option (String × String) :=
  let cs := signed.toList
  match cs.reverse.findIdx? (· == '.') with
  | none => none
  | some k =>
    let idx := cs.length - 1 - k
    some (String.ofList (cs.take idx), String.ofList (cs.drop (idx + 1)))

/-- Is a session row still good? Inclusive: a row expiring exactly now is valid. -/
def sessionIsValid (expiresAtMs nowMs : Int) : Bool := nowMs ≤ expiresAtMs

/-- Paths a share recipient may POST to despite being read-only. Only telemetry,
which writes the log, not the database: without it a recipient's session is
invisible. Safe only because the log line says `actor=share`; the session
carries the owner's user id. -/
def WRITES_ONLY_TO_THE_LOG : List String := ["/api/telemetry"]

/-- May this request proceed, given who is asking? `isShareViewer` is about the
session; a request with no session is stopped by the caller's session gate,
which runs first, so `true` here is not permission.

The method test is `≠ GET`, so a verb nobody has thought of is refused. -/
def mayProceed (isShareViewer : Bool) (method path : String) : Bool :=
  !isShareViewer || method == "GET" || WRITES_ONLY_TO_THE_LOG.contains path

/-- Paths that show where the owner is or has been: the timeline and everything
the map draws.

⚠ Full paths, `/api` included: the host must pass the original request path,
not a nested router's stripped one. -/
def LOCATION_PATHS : List String :=
  ["/api/velocity", "/api/locations", "/api/location/latest", "/api/location/tail"]

/-- `mayProceed`, and a share link whose owner turned location off reads none of
`LOCATION_PATHS`. The owner is never restricted by their own link's setting. -/
def mayProceedSharing (isShareViewer hidesLocation : Bool) (method path : String) : Bool :=
  mayProceed isShareViewer method path &&
    !(isShareViewer && hidesLocation && LOCATION_PATHS.contains path)

/-! ## Guards

The framing cases are recorded `verifyValue` answers. -/

#guard splitSigned "abc.SIG" == some ("abc", "SIG")
-- The `lastIndexOf` case: a value containing dots round-trips whole.
#guard splitSigned "a.b.c.SIG" == some ("a.b.c", "SIG")
-- An empty value is a value; it fails at the signature, not at the split.
#guard splitSigned ".SIG" == some ("", "SIG")
-- A trailing separator leaves an empty signature, which cannot verify.
#guard splitSigned "abc." == some ("abc", "")
-- No separator at all.
#guard splitSigned "abcdef" == none
#guard splitSigned "" == none

-- Expiry is inclusive at the boundary.
#guard sessionIsValid 1000 999 == true
#guard sessionIsValid 1000 1000 == true
#guard sessionIsValid 1000 1001 == false

-- Used an hour or less after the last write: no write. Later: a month from now.
#guard renewedExpiry SESSION_TTL_MS 0 == none
#guard renewedExpiry SESSION_TTL_MS RENEW_INTERVAL_MS == none
#guard renewedExpiry SESSION_TTL_MS (RENEW_INTERVAL_MS + 1) == some (RENEW_INTERVAL_MS + 1 + SESSION_TTL_MS)
-- The cookie outlives the idle limit, so the row decides.
#guard SESSION_COOKIE_MAX_AGE_S * 1000 > SESSION_TTL_MS

-- The owner is unrestricted.
#guard mayProceed false "POST" "/api/settings" == true
#guard mayProceed false "DELETE" "/api/share" == true
-- A share viewer may read anything the owner can.
#guard mayProceed true "GET" "/api/velocity" == true
-- …and may write nothing, whatever the verb.
#guard mayProceed true "POST" "/api/settings" == false
#guard mayProceed true "PUT" "/api/settings" == false
#guard mayProceed true "DELETE" "/api/share" == false
#guard mayProceed true "PATCH" "/api/settings" == false
-- A verb nobody has thought of yet is refused, not allowed.
#guard mayProceed true "PROPFIND" "/api/velocity" == false
-- The one path that writes only to the log.
#guard mayProceed true "POST" "/api/telemetry" == true
-- Exact path, not a prefix. A route mounted under it is a different route.
#guard mayProceed true "POST" "/api/telemetry/bulk" == false
#guard mayProceed true "POST" "/api/telemetryX" == false
-- A link without location reads health but not where the owner was.
#guard mayProceedSharing true true "GET" "/api/hrv" == true
#guard mayProceedSharing true true "GET" "/api/velocity" == false
#guard mayProceedSharing true true "GET" "/api/locations" == false
#guard mayProceedSharing true true "GET" "/api/location/latest" == false
#guard mayProceedSharing true true "GET" "/api/location/tail" == false
#guard mayProceedSharing true false "GET" "/api/velocity" == true
-- The owner's own requests ignore the link's setting.
#guard mayProceedSharing false true "GET" "/api/velocity" == true
-- A prefix-stripped path would slip past; the host passes the original.
#guard mayProceedSharing true true "GET" "/velocity" == true
-- Still read-only with location on.
#guard mayProceedSharing true false "POST" "/api/settings" == false

end Verified.Session
