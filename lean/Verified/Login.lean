/-!
# Signing in

Two security rules that would fail unnoticed.

`/login?return_to=…` lands a reconnect back where it was, and is a phishing
lever: `//evil.com` is protocol-relative, and `/\evil.com` becomes that in
browsers that normalise backslashes. ⚠ Both are rejected; anything rejected
becomes `/`, so callers redirect unconditionally.

The pending login rides in a cookie, not `state`: Nextcloud returns `state=`
empty when the browser had no NC session, so a lookup by `state` could never
sign in a cookie-less browser. `state` is still checked when returned. When it
is empty the cookie is the only binding, an accepted login-CSRF risk on a
VPN-only host within a ten-minute window.

Pure and total. UNPROVEN.
-/
namespace Verified.Login

/-- How long a started login may take to come back. -/
def PENDING_TTL_MS : Int := 10 * 60 * 1000

private def isSafePathChar (c : Char) : Bool :=
  c.isAlphanum || "_-.~+/?=&%".toList.contains c

/-- Validate a client-supplied post-login redirect; anything not clearly an
internal path, `//host` and `/\host` included, becomes `/`. -/
def validateReturnTo (raw : Option String) : String :=
  match raw with
  | none => "/"
  | some s =>
    if s == "/" then "/"
    else if s.length < 2 then "/"
    else
      let cs := s.toList
      match cs with
      | '/' :: second :: _ =>
        -- Both of these become protocol-relative in a browser.
        if second == '/' || second == '\\' then "/"
        else if cs.all isSafePathChar then s else "/"
      | _ => "/"

/-- `<expiry ms>|<nonce>|<retried 0/1>|<returnTo>`. `retried`: already sent
back to Nextcloud once for a missing `state`. `returnTo` is last, so a `|` in
it cannot rewrite the expiry. -/
def encodePending (expiresAt : Int) (nonce : String) (retried : Bool) (returnTo : Option String) : String :=
  let rt := match returnTo with | none => "" | some r => r
  toString expiresAt ++ "|" ++ nonce ++ "|" ++ (if retried then "1" else "0") ++ "|" ++ rt

/-- Inverse of [`encodePending`]. `none` when the shape is wrong. -/
def decodePending (raw : String) : Option (Int × String × Bool × Option String) :=
  let cs := raw.toList
  match cs.findIdx? (· == '|') with
  | none => none
  | some i =>
    let rest := cs.drop (i + 1)
    match rest.findIdx? (· == '|') with
    | none => none
    | some j =>
      let expiryStr := String.ofList (cs.take i)
      match expiryStr.toInt? with
      | none => none
      | some expiresAt =>
        let nonce := String.ofList (rest.take j)
        let tail := rest.drop (j + 1)
        let finish (retried : Bool) (rt : List Char) :=
          let returnTo := String.ofList rt
          some (expiresAt, nonce, retried, if returnTo.isEmpty then none else some returnTo)
        match tail with
        | '0' :: '|' :: rt => finish false rt
        | '1' :: '|' :: rt => finish true rt
        | _ => none

/-- What a callback may do with the pending login it carries. -/
inductive Callback where
  /-- `state` matched: exchange the code. -/
  | accept
  /-- `state` was lost: drop the code and authorize again, once. -/
  | retry
  | refuse
  deriving DecidableEq, Repr

def Callback.name : Callback → String
  | .accept => "accept"
  | .retry => "retry"
  | .refuse => "refuse"

/-- What may this callback do? A present `state` must match. A lost one (`none`
or empty) is never accepted (RFC 6749 §10.12): it is retried once, when
Nextcloud is signed in and returns it, and a second miss is refused. Expiry is
strict: an entry exactly at its deadline is expired. -/
def acceptPending (expiresAt : Int) (nonce : String) (retried : Bool) (state : Option String)
    (now : Int) : Callback :=
  if expiresAt < now then .refuse
  else
    let s := state.getD ""
    if s.isEmpty then (if retried then .refuse else .retry)
    else if s == nonce then .accept else .refuse

/-! ## Guards -/

-- Ordinary internal paths pass through.
#guard validateReturnTo (some "/your-day") == "/your-day"
#guard validateReturnTo (some "/your-day?date=2026-08-22") == "/your-day?date=2026-08-22"
#guard validateReturnTo (some "/") == "/"
#guard validateReturnTo none == "/"
-- The attack, both spellings.
#guard validateReturnTo (some "//evil.com") == "/"
#guard validateReturnTo (some "/\\evil.com") == "/"
-- Absolute URLs are not paths.
#guard validateReturnTo (some "https://evil.com") == "/"
#guard validateReturnTo (some "javascript:alert(1)") == "/"
-- Anything with whitespace, a control character or an unusual glyph is refused
-- rather than escaped.
#guard validateReturnTo (some "/a b") == "/"
#guard validateReturnTo (some "/a\nb") == "/"
#guard validateReturnTo (some "/<script>") == "/"
#guard validateReturnTo (some "") == "/"

-- The codec round-trips, including a `|` inside the return path.
#guard decodePending (encodePending 1000 "abc" false (some "/x")) == some (1000, "abc", false, some "/x")
#guard decodePending (encodePending 1000 "abc" true none) == some (1000, "abc", true, none)
#guard decodePending (encodePending 1000 "abc" false (some "/x?a=1|2")) == some (1000, "abc", false, some "/x?a=1|2")
#guard decodePending "not-a-pending" == none
#guard decodePending "1000|only-one-separator" == none

-- Live, and the nonce agrees, on the first try or the retry.
#guard acceptPending 1000 "n" false (some "n") 999 == .accept
#guard acceptPending 1000 "n" true (some "n") 999 == .accept
-- NC lost the state: retried, never accepted.
#guard acceptPending 1000 "n" false none 999 == .retry
#guard acceptPending 1000 "n" false (some "") 999 == .retry
-- A second miss is refused.
#guard acceptPending 1000 "n" true none 999 == .refuse
#guard acceptPending 1000 "n" true (some "") 999 == .refuse
-- A returned state that disagrees is refused.
#guard acceptPending 1000 "n" false (some "other") 999 == .refuse
-- Expired.
#guard acceptPending 1000 "n" false (some "n") 1001 == .refuse

end Verified.Login
