/-!
# Whether an account is linked

`/api/me`'s two connection statuses, from one nullable column. No row is
`not_linked` (the "connect your account" prompt).

⚠ Only the exact string `needs_reauth` is broken; every other value, including
"" or one a future migration adds, reads as `active`.

Pure and total. UNPROVEN; the `#guard`s pin its answers.
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

/-- Read a status from the stored column; `none` is no row, and anything but
`needs_reauth` is `active`. -/
def statusOf (stored : Option String) : Status :=
  match stored with
  | none => .notLinked
  | some s => if s == "needs_reauth" then .needsReauth else .active

/-- The legacy boolean `/api/me` still sends: `needs_reauth` counts as linked,
as older SPA builds expect; the typed `connections` carries the distinction. -/
def isLinked (s : Status) : Bool := s != Status.notLinked

/-! ## Guards -/

#guard statusOf none == Status.notLinked
#guard statusOf (some "needs_reauth") == Status.needsReauth
#guard statusOf (some "active") == Status.active
-- Everything unrecognised is reported as a working connection.
#guard statusOf (some "") == Status.active
#guard statusOf (some "revoked") == Status.active
#guard statusOf (some "NEEDS_REAUTH") == Status.active

#guard Status.toString (statusOf none) == "not_linked"
#guard Status.toString (statusOf (some "needs_reauth")) == "needs_reauth"
#guard Status.toString (statusOf (some "active")) == "active"

-- A revoked credential still reads as "linked" to the legacy flag.
#guard isLinked (statusOf none) == false
#guard isLinked (statusOf (some "needs_reauth")) == true
#guard isLinked (statusOf (some "active")) == true

end Verified.Connection
