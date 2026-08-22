/-!
# Whether an account is linked (port of `src/nextcloud/credentials.ts` and
`src/fitbit/token-manager.ts`)

`/api/me` reports two connection statuses, and both are computed the same way
from one nullable column. The two TypeScript functions are byte-for-byte the
same logic over different tables, which is why there is one rule here rather
than two.

⚠ THE FALL-THROUGH IS TO `active`, not to an error. Only the exact string
`needs_reauth` is treated as broken; every other value a row might carry —
including one a future migration adds, and including an empty string — reads as
a working connection. That is the TypeScript's behaviour and it is preserved,
but it means this answer is only as good as the writer's discipline: a status
nobody taught it about is reported to the user as fine.

The one thing it does refuse is ABSENCE: no row is `not_linked`, which is what
the frontend turns into its "connect your account" prompt.

Pure and total. UNPROVEN; every `#guard` is what `src/routes/api.ts` produced
under Node — see `lean/experiments/connection-refs.mts`.
-/
namespace Verified.Connection

/-- The status of one linked account. -/
inductive Status where
  /-- A row exists and is not flagged. -/
  | active
  /-- The stored credential was rejected; the user must relink. -/
  | needsReauth
  /-- No row at all. -/
  | notLinked
  deriving Repr, BEq, DecidableEq

/-- The wire spelling. These strings are the API contract — the SPA switches on
them — so renaming one is a breaking change, not a refactor. -/
def Status.toString : Status → String
  | .active => "active"
  | .needsReauth => "needs_reauth"
  | .notLinked => "not_linked"

/-- Read a status from the stored column. `none` means NO ROW.

⚠ `some ""`, `some "revoked"` and `some "anything"` are all `active`. See the
module note: this is a fall-through, not a validation. -/
def statusOf (stored : Option String) : Status :=
  match stored with
  | none => .notLinked
  | some s => if s == "needs_reauth" then .needsReauth else .active

/-- The legacy boolean `/api/me` still sends alongside the typed status.

⚠ `needs_reauth` counts as LINKED. The old SPA builds that read this flag show
"connected" for an account whose credential has been revoked; the typed
`connections` object is what carries the distinction. Narrowing this to
`active` would be more truthful and would change what those builds render. -/
def isLinked (s : Status) : Bool := s != Status.notLinked

/-! ## Guards -/

#guard statusOf none == Status.notLinked
#guard statusOf (some "needs_reauth") == Status.needsReauth
#guard statusOf (some "active") == Status.active
-- ⚠ Everything unrecognised is reported as a working connection.
#guard statusOf (some "") == Status.active
#guard statusOf (some "revoked") == Status.active
#guard statusOf (some "NEEDS_REAUTH") == Status.active

#guard Status.toString (statusOf none) == "not_linked"
#guard Status.toString (statusOf (some "needs_reauth")) == "needs_reauth"
#guard Status.toString (statusOf (some "active")) == "active"

-- ⚠ A revoked credential still reads as "linked" to the legacy flag.
#guard isLinked (statusOf none) == false
#guard isLinked (statusOf (some "needs_reauth")) == true
#guard isLinked (statusOf (some "active")) == true

end Verified.Connection
