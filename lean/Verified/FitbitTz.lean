import Verified.Civil

/-!
# Which zone a Fitbit wall clock was recorded in

Fitbit returns `22:39:00` and nothing else. The zone that makes it interpretable
is the watch's zone AT THE MOMENT OF RECORDING, which Fitbit does not keep, so
it has to be inferred — from GPS fixes when there are any near enough in time,
and from the account's profile zone otherwise.

This module is the DECISION: which of those two answers to use, and if a fix,
which fix. It is deliberately not the lookup — turning a latitude and longitude
into an IANA name needs the zone-boundary polygons, which are external data, and
`Verified` has none by design.

## ⚠ THIS IS A SPECIFICATION, AND THE RUNNING CODE IS THE RUST

`nearestFix` below is a linear scan: obviously correct, and O(N) per row. The
backend cannot use it — a day of 1-second heart rate is 86 400 rows, and a
sync window can hold thousands of fixes, so the product is ~10⁸ comparisons per
day per stream. `rust/backend/src/fitbit/tz_source.rs` binary-searches instead.

The two are checked against each other rather than trusted separately: a
differential test drives both over the same inputs through the FFI. That is
worth more here than either alone, because the failure this guards against is an
off-by-one at the tie, and a hand-written binary search is exactly where one
lives. The specification is the arbiter; if they disagree, the Rust is wrong.

## Ties go to the LATER fix

The TypeScript's search lands on `lo`, the first index at or after the target,
then steps back only when the earlier fix is STRICTLY closer. So an exact tie
keeps `lo`. Preserved rather than improved: it decides which zone a row on a
travel day is stamped with, and changing it would re-time rows already stored.
-/

namespace Verified.FitbitTz

/-- How far in time a GPS fix may be from a wall clock and still speak for it.

Six hours. Wide because the point is to catch the zone the watch was in, and a
person does not usually change zone without their phone recording something
within a quarter of a day. Narrow enough that a fix from a different trip does
not get to answer. -/
def FIX_SEARCH_WINDOW_S : Int := 6 * 60 * 60

/-- What to stamp a row with. -/
inductive TzChoice where
  /-- Use the account's profile zone. ⚠ That may itself be absent, in which
  case the row gets no zone at all — which is the correct outcome, not a
  failure. A guessed instant in a column declared to hold UTC is worse than an
  absent one, because nothing downstream can tell it was a guess. -/
  | profile
  /-- Look up the zone at this fix's coordinates. -/
  | fix (index : Nat)
  deriving Repr, DecidableEq

/-- Index of the fix closest in time to `target`, ties to the LATER one.

The specification. `times` must be sorted ascending — the caller sorts once per
sync window, and this scans it. `none` for an empty list, which is the
no-signal case. -/
def nearestFix (times : List Int) (target : Int) : Option Nat :=
  let step := fun (best : Option (Nat × Int)) (p : Nat × Int) =>
    let d := (p.2 - target).natAbs
    match best with
    | none => some (p.1, d)
    -- `≤` and not `<`: a later fix at the same distance WINS, matching the
    -- TypeScript's `lo`. This is the tie the differential test exists for.
    | some (_, bd) => if d ≤ bd then some (p.1, d) else best
  (((times.zipIdx).map (fun (t, i) => (i, t))).foldl step none).map Prod.fst

/-- The decision.

`seedUtc` is the wall clock converted to an approximate UTC instant using the
profile zone — approximate because the zone used to convert it is the one being
inferred. A couple of hours of error there is immaterial against a six-hour
window, which is part of why the window is that wide.

`none` for the seed means the wall clock did not parse, and the honest answer is
the profile zone rather than a fix chosen from a nonsense instant. -/
def decideTz (fixTimes : List Int) (seedUtc : Option Int) : TzChoice :=
  match seedUtc with
  | none => .profile
  | some seed =>
    match nearestFix fixTimes seed with
    | none => .profile
    | some i =>
      match fixTimes[i]? with
      | none => .profile
      | some t => if (t - seed).natAbs > FIX_SEARCH_WINDOW_S.toNat then .profile else .fix i

/-! ## Guards -/

private def T : List Int := [100, 200, 300]

#guard nearestFix [] 150 == none
#guard nearestFix [100] 150 == some 0
#guard nearestFix T 90 == some 0
#guard nearestFix T 140 == some 0
#guard nearestFix T 160 == some 1
#guard nearestFix T 310 == some 2
#guard nearestFix T 1000 == some 2
-- Exact hits.
#guard nearestFix T 100 == some 0
#guard nearestFix T 200 == some 1
-- ⚠ THE TIE. 150 is 50 from both 100 and 200; the LATER one wins.
#guard nearestFix T 150 == some 1
#guard nearestFix T 250 == some 2
-- Duplicated timestamps: the last of the equals wins, same rule.
#guard nearestFix [100, 100, 100] 100 == some 2

-- No fixes at all, and an unparseable wall clock, both fall back.
#guard decideTz [] (some 150) == .profile
#guard decideTz T none == .profile
-- Inside the window.
#guard decideTz T (some 150) == .fix 1
#guard decideTz [0] (some 21600) == .fix 0
-- ⚠ The window boundary is `>`: exactly six hours away still counts.
#guard decideTz [0] (some 21601) == .profile
#guard decideTz [0] (some (-21600)) == .fix 0
#guard decideTz [0] (some (-21601)) == .profile
-- A far-away fix does not get to answer just because it is the only one.
#guard decideTz [0] (some 86400) == .profile

end Verified.FitbitTz
