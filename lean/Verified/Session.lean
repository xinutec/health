/-!
# Session and share-viewer rules (port of `src/middleware/session.ts`, `share-auth.ts`)

The decisions in front of every authenticated request. What is NOT here, and
deliberately: the HMAC, the CSPRNG that mints a session id, and the constant-time
compare. Those are `randomBytes`-shaped — there is nothing to prove about them
beyond that they were asked for, and a Lean model of one would be fiction. The
worked split is `src/share/token.ts`, recorded in `rust/backend/src/lib.rs`.

What IS here is everything a wrong three-liner would silently change:

* **the framing of a signed cookie**, which splits on the LAST separator;
* **when a session has expired**, and which side of the boundary is still valid;
* **what a share recipient may do**, which is the rule protecting the owner's
  data from a link they forwarded.

Pure and total. UNPROVEN; pinned by the `#guard`s, and the framing cases are what
`verifyValue` actually returned under Node — see `lean/experiments/session-refs.mts`.
-/

namespace Verified.Session

/-- A week. Long enough that a phone kept in a pocket stays logged in across a
holiday, short enough that a forgotten browser on a borrowed machine stops
working. -/
def SESSION_TTL_MS : Int := 7 * 24 * 60 * 60 * 1000

/-- The cookie's `Max-Age`, in seconds — the TTL the row is written with, so the
browser forgets the cookie at the same moment the row stops being honoured. -/
def SESSION_COOKIE_MAX_AGE_S : Int := SESSION_TTL_MS / 1000

def SESSION_COOKIE_NAME : String := "session"

/-- Split a signed value into `(value, signature)`.

⚠ **THE LAST SEPARATOR, NOT THE FIRST.** The signature is base64url, whose
alphabet has no `.`, so everything before the final dot is the value and a value
containing dots round-trips. Splitting on the first dot would hand the verifier a
TRUNCATED value and the rest of the value as the signature — which fails closed
for a well-formed cookie, and is the kind of near-miss that gets "fixed" by
loosening the comparison.

`none` when there is no separator at all. An EMPTY value is a value: `".sig"`
splits to `("", "sig")` and fails at the signature check, which is where it
should fail. -/
def splitSigned (signed : String) : Option (String × String) :=
  let cs := signed.toList
  match cs.reverse.findIdx? (· == '.') with
  | none => none
  | some k =>
    let idx := cs.length - 1 - k
    some (String.ofList (cs.take idx), String.ofList (cs.drop (idx + 1)))

/-- Is a session row still good?

⚠ INCLUSIVE at the boundary: the TypeScript expires a row when `expires_at <
now`, so a row expiring exactly now is still valid. Kept because flipping it
would log a user out one millisecond earlier for no reason anyone could observe,
and because the boundary is the sort of thing that gets flipped by accident when
someone "tidies" the comparison. -/
def sessionIsValid (expiresAtMs nowMs : Int) : Bool := nowMs ≤ expiresAtMs

/-- Paths a share recipient may POST to despite being read-only.

Exactly one, and it is not an exception to the rule so much as outside its
subject: the rule protects the owner's DATA, and telemetry writes to the log
rather than the database — `POST /api/telemetry` stores nothing.

It is allowed because the alternative is a blind spot exactly where problems are
least visible. A share recipient is the one person who cannot be asked what they
saw, and without this their whole session is invisible.

⚠ Safe ONLY because the log line names who acted. A share viewer's session
carries the OWNER's user id, so the log must say `actor=share`; without that,
opening this path makes the log claim the owner did it. -/
def WRITES_ONLY_TO_THE_LOG : List String := ["/api/telemetry"]

/-- May this request proceed, given who is asking?

⚠ `isShareViewer` is about the SESSION, not about the token. A request with no
session at all is not a share viewer, and this is not the check that stops it —
that is the caller's "is there a session" gate, which must run first. Answering
`true` here for an unauthenticated request is correct and is not permission.

⚠ The method test is `≠ GET`, not a list of writing verbs. A verb nobody has
thought of yet is refused rather than allowed, which is the direction that fails
safe when the API grows. -/
def mayProceed (isShareViewer : Bool) (method path : String) : Bool :=
  !isShareViewer || method == "GET" || WRITES_ONLY_TO_THE_LOG.contains path

/-! ## Guards

The framing cases are what `verifyValue` returned under Node; regenerate with
`npx tsx lean/experiments/session-refs.mts`. -/

#guard splitSigned "abc.SIG" == some ("abc", "SIG")
-- ⚠ The `lastIndexOf` case: a value containing dots round-trips whole.
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

-- The owner is unrestricted.
#guard mayProceed false "POST" "/api/settings" == true
#guard mayProceed false "DELETE" "/api/share" == true
-- A share viewer may read anything the owner can.
#guard mayProceed true "GET" "/api/velocity" == true
-- ⚠ …and may write nothing, whatever the verb.
#guard mayProceed true "POST" "/api/settings" == false
#guard mayProceed true "PUT" "/api/settings" == false
#guard mayProceed true "DELETE" "/api/share" == false
#guard mayProceed true "PATCH" "/api/settings" == false
-- A verb nobody has thought of yet is refused, not allowed.
#guard mayProceed true "PROPFIND" "/api/velocity" == false
-- The one path that writes only to the log.
#guard mayProceed true "POST" "/api/telemetry" == true
-- ⚠ EXACT path, not a prefix. A route mounted under it is a different route.
#guard mayProceed true "POST" "/api/telemetry/bulk" == false
#guard mayProceed true "POST" "/api/telemetryX" == false

end Verified.Session
