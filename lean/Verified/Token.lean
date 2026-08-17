import Verified.Civil

/-!
# OAuth token decisions

Two rules the token manager carried in Rust, moved here because each one gets a
durable answer wrong in a way nothing downstream can see.

## Why the 4xx/5xx split is not a detail

A refresh that fails with 4xx means the refresh token is dead — invalid,
expired, revoked or throttled — and the manager flips `tokens.status` to
`needs_reauth`. That is DURABLE and USER-VISIBLE: `/api/me` surfaces it and the
sync stops until somebody re-links the account by hand.

A 5xx is Fitbit having a bad minute. Classifying one as the other forces a
pointless re-link, and the evidence that it was wrong is gone by the time
anybody looks — the status says `needs_reauth` and nothing records that the
upstream was a 503. It is the same shape as `Verified.Backfill`'s `complete`,
and it gets the same treatment: named boundaries, both sides guarded.

⚠ 3xx IS TRANSIENT, not a re-auth. `fetch`'s `res.ok` covers 200–299 only, so
the TypeScript falls through a 3xx to its generic throw. Preserved, and stated,
because "not 2xx and not 4xx" is easy to read as "must be 5xx".
-/

namespace Verified.Token

/-- Refresh at least this long before expiry, so a token cannot go stale
between the check and the request that uses it. -/
def REFRESH_SKEW_MS : Int := 5 * 60 * 1000

/-- Fitbit's default when the refresh response omits `expires_in`. -/
def DEFAULT_EXPIRES_IN_S : Int := 8 * 3600

/-- Whether the cached token can still be used. -/
inductive TokenUse where
  | use
  | refresh
  deriving Repr, DecidableEq

/-- The skew is subtracted from the EXPIRY, not added to the clock, and the
comparison is strict — at exactly the skew boundary the token is refreshed. -/
def decideTokenUse (nowMs expiresAtMs : Int) : TokenUse :=
  if nowMs < expiresAtMs - REFRESH_SKEW_MS then .use else .refresh

/-- What a refresh response means. -/
inductive RefreshOutcome where
  /-- 2xx. New tokens; persist them. -/
  | rotated
  /-- 4xx. The refresh token is dead. ⚠ DURABLE — flips `needs_reauth`. -/
  | reauthRequired
  /-- Anything else, including 3xx and 5xx. Retry later; change nothing. -/
  | transient
  deriving Repr, DecidableEq

def classifyRefreshStatus (status : Int) : RefreshOutcome :=
  if 200 ≤ status && status < 300 then .rotated
  else if 400 ≤ status && status < 500 then .reauthRequired
  else .transient

/-- The instant a token issued now expires. `none` for `expires_in` uses
Fitbit's documented default rather than treating the token as already dead. -/
def expiryFromNow (nowMs : Int) (expiresInS : Option Int) : Int :=
  nowMs + (expiresInS.getD DEFAULT_EXPIRES_IN_S) * 1000

/-! ## Guards -/

-- Well inside the window.
#guard decideTokenUse 0 3600000 == .use
-- One millisecond inside the skew still uses.
#guard decideTokenUse 0 (REFRESH_SKEW_MS + 1) == .use
-- ⚠ Exactly at the boundary refreshes: the comparison is strict.
#guard decideTokenUse 0 REFRESH_SKEW_MS == .refresh
#guard decideTokenUse 0 (REFRESH_SKEW_MS - 1) == .refresh
-- Already expired, and past expired.
#guard decideTokenUse 1000 1000 == .refresh
#guard decideTokenUse 2000 1000 == .refresh

-- Every boundary of the status classification, both sides.
#guard classifyRefreshStatus 200 == .rotated
#guard classifyRefreshStatus 201 == .rotated
#guard classifyRefreshStatus 299 == .rotated
#guard classifyRefreshStatus 199 == .transient
#guard classifyRefreshStatus 300 == .transient
-- ⚠ 3xx is TRANSIENT, not a re-auth. `res.ok` is 200–299 only.
#guard classifyRefreshStatus 301 == .transient
#guard classifyRefreshStatus 399 == .transient
#guard classifyRefreshStatus 400 == .reauthRequired
#guard classifyRefreshStatus 401 == .reauthRequired
#guard classifyRefreshStatus 403 == .reauthRequired
#guard classifyRefreshStatus 429 == .reauthRequired
#guard classifyRefreshStatus 499 == .reauthRequired
-- ⚠ 5xx must NOT flip the durable flag.
#guard classifyRefreshStatus 500 == .transient
#guard classifyRefreshStatus 502 == .transient
#guard classifyRefreshStatus 503 == .transient
#guard classifyRefreshStatus 599 == .transient
-- Nonsense is transient too: an unrecognisable status is not evidence that a
-- token is dead.
#guard classifyRefreshStatus 0 == .transient
#guard classifyRefreshStatus (-1) == .transient
#guard classifyRefreshStatus 600 == .transient

#guard expiryFromNow 1000 (some 3600) == 3601000
#guard expiryFromNow 1000 none == 1000 + 8 * 3600 * 1000
-- A zero or negative expires_in is honoured rather than replaced: Fitbit said
-- it, and silently substituting eight hours would use a token past its life.
#guard expiryFromNow 1000 (some 0) == 1000
#guard expiryFromNow 1000 (some (-1)) == 0

end Verified.Token
