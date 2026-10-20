/-!
# Signing in (port of `src/middleware/return-to.ts` and
`src/middleware/pending-login.ts`)

Two rules that guard the sign-in redirect. Both are small, both are security
boundaries, and both fail in ways a user would not notice.

## `return_to` is an OPEN-REDIRECT guard

`/login?return_to=…` exists so a reconnect banner can land the user back where
they were. It is also the classic phishing lever: a link like
`/login?return_to=//evil.com` sends the browser off-site AFTER a successful
login, when the user has every reason to trust what they are looking at.

⚠ The accepted shape is deliberately narrow, and the two rejections that matter
are not obvious:

* `//evil.com` is PROTOCOL-RELATIVE. It looks like a path and is not.
* `/\evil.com` — some browsers normalise a backslash to a slash, so this
  becomes the previous case inside the browser and not inside a naive check.

Anything rejected becomes `/`, so callers can redirect to the result
unconditionally rather than carrying a branch that might be forgotten.

## The pending login rides in a cookie, not in `state`

⚠ Nextcloud DROPS the `state` parameter when the browser has no NC session: it
bounces to its own login flow and comes back with `state=` empty. A server that
looks a pending login up by `state` therefore cannot sign in a cookie-less
browser AT ALL — found in the sibling fleetwatch service, whose Android WebView
lost its NC cookie and could never sign in again.

So `state` is still sent and still checked WHEN RETURNED, and the cookie is what
binds the callback to the browser that started it.

⚠ Residual risk, accepted deliberately rather than overlooked: when NC returns
an empty `state`, the cookie is the only binding, so a login-CSRF is possible
for someone who can both reach this VPN-only host and land a callback in the
victim's browser inside the ten-minute window. The alternative is a login that
cannot be performed.

Pure and total. UNPROVEN.
-/
namespace Verified.Login

/-- How long a started login may take to come back. -/
def PENDING_TTL_MS : Int := 10 * 60 * 1000

private def isSafePathChar (c : Char) : Bool :=
  c.isAlphanum || "_-.~+/?=&%".toList.contains c

/-- Validate a client-supplied post-login redirect. Anything not clearly an
internal path becomes `/`.

⚠ Rejects `//host` and `/\host` explicitly — see the module note on why those
two are the cases that matter. -/
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
        -- ⚠ BOTH of these become protocol-relative in a browser.
        if second == '/' || second == '\\' then "/"
        else if cs.all isSafePathChar then s else "/"
      | _ => "/"

/-- `<expiry ms>|<nonce>|<retried 0/1>|<returnTo>`.

`retried` says this login was already sent back to Nextcloud once for a missing
`state`; a second miss is refused.

⚠ `returnTo` is LAST so a `|` inside a query string cannot shift the fields. A
format putting it in the middle would let a crafted `return_to` rewrite the
expiry. -/
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

/-- What may this callback do?

`state` is what Nextcloud returned: `none` or empty when it was lost through
the login flow. Present means it MUST match. ⚠ Lost is never accepted
(RFC 6749 §10.12): nothing then ties the URL's code to this browser, so anyone's
code would sign it in. It is retried once — the retry finds Nextcloud signed
in, so `state` comes back — and a second miss is refused.

⚠ Expiry is strict — an entry exactly at its deadline is expired. -/
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
-- ⚠ THE ATTACK, both spellings.
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
-- ⚠ NC lost the state: retried, never accepted.
#guard acceptPending 1000 "n" false none 999 == .retry
#guard acceptPending 1000 "n" false (some "") 999 == .retry
-- A second miss is refused.
#guard acceptPending 1000 "n" true none 999 == .refuse
#guard acceptPending 1000 "n" true (some "") 999 == .refuse
-- A returned state that DISAGREES is refused.
#guard acceptPending 1000 "n" false (some "other") 999 == .refuse
-- Expired.
#guard acceptPending 1000 "n" false (some "n") 1001 == .refuse

end Verified.Login
