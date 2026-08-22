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

/-- `<expiry ms>|<nonce>|<returnTo>`.

⚠ `returnTo` is LAST so a `|` inside a query string cannot shift the fields. A
format putting it in the middle would let a crafted `return_to` rewrite the
expiry. -/
def encodePending (expiresAt : Int) (nonce : String) (returnTo : Option String) : String :=
  let rt := match returnTo with | none => "" | some r => r
  toString expiresAt ++ "|" ++ nonce ++ "|" ++ rt

/-- Inverse of [`encodePending`]. `none` when the shape is wrong. -/
def decodePending (raw : String) : Option (Int × String × Option String) :=
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
        let returnTo := String.ofList (rest.drop (j + 1))
        some (expiresAt, nonce, if returnTo.isEmpty then none else some returnTo)

/-- May this callback complete the pending login?

`state` is what Nextcloud returned: `none` when it was lost through the login
flow. Present means it MUST match; absent means the cookie stands alone.

⚠ Expiry is strict — an entry exactly at its deadline is expired. -/
def acceptPending (expiresAt : Int) (nonce : String) (state : Option String) (now : Int) : Bool :=
  if expiresAt < now then false
  else match state with
    | none => true
    | some s => if s.isEmpty then true else s == nonce

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
#guard decodePending (encodePending 1000 "abc" (some "/x")) == some (1000, "abc", some "/x")
#guard decodePending (encodePending 1000 "abc" none) == some (1000, "abc", none)
#guard decodePending (encodePending 1000 "abc" (some "/x?a=1|2")) == some (1000, "abc", some "/x?a=1|2")
#guard decodePending "not-a-pending" == none
#guard decodePending "1000|only-one-separator" == none

-- Live, and the nonce agrees.
#guard acceptPending 1000 "n" (some "n") 999 == true
-- ⚠ NC lost the state: the cookie stands alone.
#guard acceptPending 1000 "n" none 999 == true
#guard acceptPending 1000 "n" (some "") 999 == true
-- A returned state that DISAGREES is refused.
#guard acceptPending 1000 "n" (some "other") 999 == false
-- Expired.
#guard acceptPending 1000 "n" (some "n") 1001 == false

end Verified.Login
