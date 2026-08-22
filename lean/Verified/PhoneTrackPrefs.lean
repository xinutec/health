import Verified.Civil
/-!
# The PhoneTrack visualisation filter's start date (port of
`src/nextcloud/phonetrack-prefs.ts`)

The dashboard re-sets PhoneTrack's date filter each time it loads, so the map
opens on "the day you are currently living" rather than on the calendar day.
Those differ before dawn: at 02:00 the interesting track is yesterday's, still
in progress as far as the person is concerned.

So the rule is one comparison — before 06:00 LOCAL, the window starts
yesterday; at or after it, today.

⚠ The cutoff is a claim about PEOPLE, not about clocks. It says a night out
belongs to the evening it started, which is why it is a named constant here
rather than an inline 6 in a route.

⚠ LOCAL hour, and the local calendar day. The host resolves the zone — Lean has
no zone database — and passes the already-local `(y, m, d, hour)`. Handing it
UTC parts would silently shift the boundary by the offset, which is invisible
in London in winter and wrong everywhere else.

Pure and total. UNPROVEN.
-/
namespace Verified.PhoneTrackPrefs

/-- Before this LOCAL hour, the window still belongs to yesterday. -/
def NIGHT_CUTOFF_HOUR : Int := 6

/-- The local calendar date whose 00:00 is the filter's start.

⚠ Rolls through the civil calendar, so it crosses a month, a year and a leap
day correctly. Subtracting 86400 from a timestamp would agree on most days and
not across a DST change — which is exactly the kind of day someone would be
looking at the map to understand. -/
def dateminDate (y m d hour : Int) : String :=
  if hour < NIGHT_CUTOFF_HOUR then
    let (y', m', d') := Verified.Civil.civilFromDays (Verified.Civil.daysFromCivil y m d - 1)
    Verified.Civil.formatDate y' m' d'
  else Verified.Civil.formatDate y m d

/-! ## Guards -/

-- At or after the cutoff: today.
#guard dateminDate 2026 8 22 6 == "2026-08-22"
#guard dateminDate 2026 8 22 12 == "2026-08-22"
#guard dateminDate 2026 8 22 23 == "2026-08-22"
-- ⚠ Before it: YESTERDAY, because the night belongs to the evening it started.
#guard dateminDate 2026 8 22 5 == "2026-08-21"
#guard dateminDate 2026 8 22 0 == "2026-08-21"
-- Month, year and leap-day rollovers.
#guard dateminDate 2026 8 1 2 == "2026-07-31"
#guard dateminDate 2026 1 1 2 == "2025-12-31"
#guard dateminDate 2026 3 1 2 == "2026-02-28"
#guard dateminDate 2024 3 1 2 == "2024-02-29"

end Verified.PhoneTrackPrefs
