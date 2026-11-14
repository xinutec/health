import Verified.Civil
/-!
# The PhoneTrack visualisation filter's start date

The dashboard sets PhoneTrack's date filter on load to the day being lived, not
the calendar day: before 06:00 local the window starts yesterday, since a night
out belongs to the evening it started. The host passes the local
`(y, m, d, hour)`; UTC parts would shift the boundary by the offset.

Pure and total. UNPROVEN.
-/
namespace Verified.PhoneTrackPrefs

/-- Before this local hour, the window still belongs to yesterday. -/
def NIGHT_CUTOFF_HOUR : Int := 6

/-- The local calendar date whose 00:00 starts the filter, rolled through the
civil calendar: subtracting 86400 s goes wrong across a DST change. -/
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
-- Before it: yesterday, because the night belongs to the evening it started.
#guard dateminDate 2026 8 22 5 == "2026-08-21"
#guard dateminDate 2026 8 22 0 == "2026-08-21"
-- Month, year and leap-day rollovers.
#guard dateminDate 2026 8 1 2 == "2026-07-31"
#guard dateminDate 2026 1 1 2 == "2025-12-31"
#guard dateminDate 2026 3 1 2 == "2026-02-28"
#guard dateminDate 2024 3 1 2 == "2024-02-29"

end Verified.PhoneTrackPrefs
