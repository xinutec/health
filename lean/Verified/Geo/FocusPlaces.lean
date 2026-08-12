import Verified.Hsmm.FloatScore
import Verified.Geo.Velocity
/-!
# Focus-place mining (port of `src/geo/focus-places.ts`)

The whole pipeline that turns raw GPS into the user's long-term places:

`detectFocusPlaces` = filter low-accuracy fixes → `detectStays` (greedy
radius-bounded windows) → `clusterStays` (greedy nearest-cluster assignment
plus a merge-to-fixpoint pass) → `splitCluster` (separate two co-located
places by time-of-day) → re-id and sort by dwell.

Plus the classification layer: `classifyClusterLabel` (home / work / hotel /
frequent / one-off / other), `assignDisplayNames` (at most one Home and one
Work, then a "Stay" tier), the hour-of-day dwell profiles that
`Verified.Geo.PlacePrior` scores against, and `pickWinningAmenity`.

The TS file is wholly pure — time-of-day comes from LONGITUDE (rough solar
time), not a tz library, precisely so this layer needs no `Intl`. So the whole
module ports, with two deliberate exceptions:

* **`classifyCluster.reason`** — a human-readable string built with
  `toFixed(0)`. Only the LABEL drives behaviour, so `classifyClusterLabel`
  returns the decision and the display string stays shell. (Same split as
  `refinedReason` in `Verified.Geo.Segments`.)
* **`ymdLocal`** — the TS formats a `YYYY-MM-DD` string purely so a `Set` can
  count distinct days. {@link localDayIndex} returns the day NUMBER instead.
  Calendar date and day index are in bijection, so the distinct COUNT — the
  only thing `uniqueDayCount` exposes — is identical, without a civil-date
  conversion.

Exactness: stay/cluster geometry and every gate, ordering and label decision
are EXACT; `haversineMeters` (atan2) and the `cos`/`sin` circular embedding in
`splitCluster` put those distances at ≤1 ULP. UNPROVEN; pinned by the
`#guard`s against Node/V8 (`lean/experiments/focus-places-refs.mts`).
-/

namespace Verified.Geo.FocusPlaces

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Geo.Velocity (localSolarHour)

/-! ## Calibration (verbatim from the TS) -/

def STAY_RADIUS_M : Float := 100
/-- How long a dwell must last to be MINED as a visit. Short enough to catch
cafés.

NOT `Verified.Geo.Segments.SEGMENT_STAY_MIN_S` (15 min), which asks whether
there is a stay in the track at all. This is the LOWER bar, on purpose. Both
were called `STAY_MIN_DURATION_SEC` until #762. -/
def FOCUS_VISIT_MIN_S : Int := 10 * 60
def ACCURACY_FILTER_M : Float := 200
def CLUSTER_RADIUS_M : Float := 150

structure RawPoint where
  ts : Int
  lat : Float
  lon : Float
  accuracy : Option Float := none
  deriving Inhabited, BEq

structure Stay where
  startTs : Int
  endTs : Int
  centroidLat : Float
  centroidLon : Float
  pointCount : Nat
  durationSec : Int
  deriving Inhabited, BEq

structure Cluster where
  id : Int
  centroidLat : Float
  centroidLon : Float
  stays : List Stay
  totalDwellSec : Int
  deriving Inhabited, BEq

/-- The generic display name for a sometime-sleep cluster we could not tie to
    a named place. Unlike Home/Work it names no specific place, so a mined
    venue name should outrank it in any human label. -/
def STAY_DISPLAY_NAME : String := "Stay"

/-! ## Solar time

`localSolarHour` is shared with `Verified.Geo.Velocity`. The two variants
below are focus-places' own. -/

private def MIN_PER_DAY : Float := 24 * 60

/-- Positive-mod against a period, matching JS `((x % p) + p) % p`. -/
private def wrapTo (x period : Float) : Float := x - Float.floor (x / period) * period

/-- Local solar hour as a continuous value in `[0, 24)` — like
    `localSolarHour` but not floored. `splitCluster`'s circular embedding
    needs sub-hour resolution. -/
def localSolarHourFractional (ts : Int) (lon : Float) : Float :=
  let utcMinutes := Float.ofInt ((ts / 60) % 1440) + Float.ofInt (ts % 60) / 60
  wrapTo (utcMinutes + (lon / 15) * 60) MIN_PER_DAY / 60

/-- Day-of-week in the cluster's local solar time. 0 = Monday, 6 = Sunday. -/
def localSolarDayOfWeek (ts : Int) (lon : Float) : Nat :=
  let offsetSec := Float.floor ((lon / 15) * 3600 + 0.5)
  let localTs := ts + offsetSec.toInt64.toInt
  -- Unix day 0 is a Thursday, which `getUTCDay` numbers 4 (Sun = 0).
  let utcDay := ((Int.fdiv localTs 86400) + 4).emod 7
  ((utcDay + 6).emod 7).toNat

/-- The local-solar day a timestamp falls in, as a day NUMBER. Replaces the
    TS `ymdLocal` string: dates and day indices are in bijection, so distinct
    counts agree, and no civil-date conversion is needed. -/
def localDayIndex (ts : Int) (lon : Float) : Int :=
  let offsetSec := Float.floor ((lon / 15) * 3600 + 0.5)
  Int.fdiv (ts + offsetSec.toInt64.toInt) 86400

private def hourIdx (ts : Int) (lon : Float) : Nat := (localSolarHour ts lon).toUInt64.toNat

/-! ## Stay detection -/

/-- Upper median: the TS sorts ascending and indexes `⌊n/2⌋`. -/
private def median (xs : List Float) : Float :=
  let sorted := xs.mergeSort (fun a b => decide (a ≤ b))
  sorted.getD (xs.length / 2) 0

private def medianCentroid (ps : List RawPoint) : Float × Float :=
  (median (ps.map (·.lat)), median (ps.map (·.lon)))

private def maxDistFromCentroid (ps : List RawPoint) (lat lon : Float) : Float :=
  ps.foldl (fun m p => max m (haversineMeters lat lon p.lat p.lon)) 0

/--
Greedily extend a window while every point stays within `STAY_RADIUS_M` of its
own median centroid; the radius check is what eventually breaks the window
when the phone moves elsewhere. A window of ≥2 points spanning
`FOCUS_VISIT_MIN_S` becomes a stay and the scan resumes after it;
otherwise the scan advances one point and tries again.
-/
def detectStays (points : List RawPoint) : List Stay := Id.run do
  let pts := points.toArray
  let n := pts.size
  let mut stays : Array Stay := #[]
  let mut i := 0
  while i < n do
    let mut j := i + 1
    let mut bestJ := i + 1
    while j < n do
      let slice := (pts.extract i (j + 1)).toList
      let (cLat, cLon) := medianCentroid slice
      if decide (maxDistFromCentroid slice cLat cLon > STAY_RADIUS_M) then break
      j := j + 1
      bestJ := j
    let slice := (pts.extract i bestJ).toList
    let mut advanced := false
    if slice.length ≥ 2 then
      let (cLat, cLon) := medianCentroid slice
      let first := slice.headD default
      let last := slice.getLastD default
      let duration := last.ts - first.ts
      if decide (duration ≥ FOCUS_VISIT_MIN_S) then
        stays := stays.push ⟨first.ts, last.ts, cLat, cLon, slice.length, duration⟩
        i := bestJ
        advanced := true
    if !advanced then i := i + 1
  return stays.toList

/-! ## Clustering -/

/-- Fold a stay into a cluster, moving the centroid by dwell weight. -/
private def addStayToCluster (c : Cluster) (s : Stay) : Cluster :=
  let total := c.totalDwellSec + s.durationSec
  let oldWeight := Float.ofInt c.totalDwellSec
  let w := Float.ofInt s.durationSec
  let t := Float.ofInt total
  { c with
    stays := c.stays ++ [s],
    totalDwellSec := total,
    centroidLat := (c.centroidLat * oldWeight + s.centroidLat * w) / t,
    centroidLon := (c.centroidLon * oldWeight + s.centroidLon * w) / t }

private def mergeCluster (into other : Cluster) : Cluster :=
  let totalAfter := into.totalDwellSec + other.totalDwellSec
  let wI := Float.ofInt into.totalDwellSec
  let wO := Float.ofInt other.totalDwellSec
  let t := Float.ofInt totalAfter
  { into with
    centroidLat := (into.centroidLat * wI + other.centroidLat * wO) / t,
    centroidLon := (into.centroidLon * wI + other.centroidLon * wO) / t,
    totalDwellSec := totalAfter,
    stays := into.stays ++ other.stays }

/-- The first `(i, j)` pair of clusters within `CLUSTER_RADIUS_M`, scanning in
    the TS's order (the `break outer` restarts the whole scan after a merge). -/
private def firstMergeablePair (cs : Array Cluster) : Option (Nat × Nat) := Id.run do
  for i in [0 : cs.size] do
    for j in [i + 1 : cs.size] do
      let a := cs[i]!
      let b := cs[j]!
      if decide (haversineMeters a.centroidLat a.centroidLon b.centroidLat b.centroidLon ≤ CLUSTER_RADIUS_M) then
        return some (i, j)
  return none

/--
Greedy assignment to the nearest in-range cluster, then merge to a fixpoint:
greedy clustering can leave two clusters whose centroids drift within range
only after the fact.
-/
def clusterStays (stays : List Stay) : List Cluster := Id.run do
  let mut clusters : Array Cluster := #[]
  for stay in stays do
    let mut bestIdx : Option Nat := none
    let mut bestDist := (1.0 / 0.0 : Float)
    for i in [0 : clusters.size] do
      let c := clusters[i]!
      let d := haversineMeters c.centroidLat c.centroidLon stay.centroidLat stay.centroidLon
      if decide (d < bestDist) && decide (d ≤ CLUSTER_RADIUS_M) then
        bestIdx := some i
        bestDist := d
    match bestIdx with
    | some i => clusters := clusters.set! i (addStayToCluster clusters[i]! stay)
    | none =>
      clusters := clusters.push
        ⟨Int.ofNat clusters.size + 1, stay.centroidLat, stay.centroidLon, [stay], stay.durationSec⟩
  repeat
    match firstMergeablePair clusters with
    | none => break
    | some (i, j) =>
      clusters := clusters.set! i (mergeCluster clusters[i]! clusters[j]!)
      clusters := clusters.eraseIdx! j
  return clusters.toList

/-! ## Hour profiles -/

def HOUR_BUCKETS : Nat := 24
private def HOUR_PROFILE_STEP_SEC : Int := 30 * 60

/-- Normalised 24-bucket dwell histogram over some time ranges, keyed by local
    solar hour and sampled every 30 min. Sums to 1 (all-zero only for
    genuinely empty input). -/
def hourHistogram (ranges : List (Int × Int)) (lon : Float) : List Float := Id.run do
  let mut buckets : Array Float := Array.replicate HOUR_BUCKETS 0
  for (startTs, endTs) in ranges do
    let mut t := startTs
    while t ≤ endTs do
      let h := hourIdx t lon
      buckets := buckets.set! h (buckets[h]! + 1)
      t := t + HOUR_PROFILE_STEP_SEC
  let total := buckets.foldl (fun s b => s + b) 0
  if total == 0 then return buckets.toList
  return (buckets.map (fun b => b / total)).toList

/-- Where, across the local solar clock, this place's visits spend their time. -/
def hourProfileOf (c : Cluster) : List Float :=
  hourHistogram (c.stays.map (fun s => (s.startTs, s.endTs))) c.centroidLon

/-- The runtime counterpart of `hourProfileOf`, for scoring one stay against
    each place's mined profile. -/
def hourProfileForRange (startTs endTs : Int) (lon : Float) : List Float :=
  hourHistogram [(startTs, endTs)] lon

/-- 24 permille integers, comma-joined. -/
def serializeHourProfile (profile : List Float) : String :=
  String.intercalate "," (profile.map (fun x => toString (Float.floor (x * 1000 + 0.5)).toInt64.toInt))

/-- JS `Number(s)` restricted to what `serializeHourProfile` can emit plus the
    degenerate inputs the TS tolerates: surrounding whitespace is ignored, the
    EMPTY string is 0 (a real JS quirk this relies on), and anything else is
    `none` = `NaN` ⇒ the whole profile is rejected. -/
private def jsNumber (s : List Char) : Option Float := Id.run do
  let t := (s.dropWhile (fun c => c == ' ')).reverse.dropWhile (fun c => c == ' ') |>.reverse
  if t.isEmpty then return some 0
  let (neg, digits) := match t with
    | '-' :: r => (true, r)
    | '+' :: r => (false, r)
    | r => (false, r)
  if digits.isEmpty then return none
  let mut intPart : Float := 0
  let mut frac : Float := 0
  let mut scale : Float := 1
  let mut seenDot := false
  let mut anyDigit := false
  for c in digits do
    if c == '.' then
      if seenDot then return none
      seenDot := true
    else if c.isDigit then
      anyDigit := true
      let d := Float.ofNat (c.toNat - 48)
      if seenDot then
        scale := scale / 10
        frac := frac + d * scale
      else
        intPart := intPart * 10 + d
    else return none
  if !anyDigit then return none
  return some (if neg then -(intPart + frac) else intPart + frac)

/-- Parse a stored profile back to fractions. `none` for a missing or
    malformed value — callers treat that as "no time-of-day signal". -/
def parseHourProfile (s : Option String) : Option (List Float) :=
  match s with
  | none => none
  | some str =>
    if str.isEmpty then none
    else
      let parts := str.splitOn ","
      if parts.length != HOUR_BUCKETS then none
      else
        let parsed := parts.map (fun p => jsNumber p.toList)
        if parsed.any (·.isNone) then none
        else some (parsed.map (fun p => (p.getD 0) / 1000))

/-! ## Sleep signals -/

private def DEEP_NIGHT_START_HOUR : Nat := 2
private def DEEP_NIGHT_END_HOUR : Nat := 6

private def stayCoversDeepNight (s : Stay) (lon : Float) : Bool := Id.run do
  let mut t := s.startTs
  while t ≤ s.endTs do
    let h := hourIdx t lon
    if h ≥ DEEP_NIGHT_START_HOUR && h < DEEP_NIGHT_END_HOUR then return true
    t := t + 1800
  return false

/-- Total dwell, in hours, of stays that cover any of 02:00–06:00 local solar
    time — the "you sleep here sometimes" signal. Robust to varied sleep
    schedules and to long café visits, which never cross deep night. -/
def sleepHoursOf (c : Cluster) : Float :=
  Float.ofInt (c.stays.foldl (fun sec s => if stayCoversDeepNight s c.centroidLon then sec + s.durationSec else sec) 0)
  / 3600

/-- Actual overlap between each stay and any Fitbit sleep window. Strictly
    more accurate than `sleepHoursOf` when Fitbit data exists: it catches
    shifted-sleep nights the 02:00–06:00 heuristic misses, and excludes
    "sat at home from 22:00 to 04:00 watching TV". Returns 0 with no
    windows, so the caller can fall back. -/
def sleepHoursFromFitbit (stays : List Stay) (sleepWindows : List (Int × Int)) : Float :=
  if sleepWindows.isEmpty then 0
  else
    let totalSec := stays.foldl (fun acc s =>
      sleepWindows.foldl (fun a (ws, we) =>
        let overlapStart := max s.startTs ws
        let overlapEnd := min s.endTs we
        if overlapEnd > overlapStart then a + (overlapEnd - overlapStart) else a) acc) 0
    Float.ofInt totalSec / 3600

private def sumHourBucket (stays : List Stay) (lon : Float) (hStart hEnd : Nat) : Float := Id.run do
  let mut hours : Float := 0
  for s in stays do
    let mut t := s.startTs
    while t ≤ s.endTs do
      let h := hourIdx t lon
      if h ≥ hStart && h < hEnd then hours := hours + 0.5
      t := t + 1800
  return hours

private def weekdayDaytimeHours (stays : List Stay) (lon : Float) : Float := Id.run do
  let mut hours : Float := 0
  for s in stays do
    let mut t := s.startTs
    while t ≤ s.endTs do
      let dow := localSolarDayOfWeek t lon
      let h := hourIdx t lon
      if dow ≤ 4 && h ≥ 9 && h < 17 then hours := hours + 0.5
      t := t + 1800
  return hours

/-- Distinct local-solar days on which this place was visited. -/
def uniqueDayCount (stays : List Stay) (lon : Float) : Nat :=
  (stays.map (fun s => localDayIndex s.startTs lon)).eraseDups.length

/-! ## Classification -/

/--
`home | work | hotel | frequent | one-off | other`.

Only the label drives behaviour; the TS also builds a human-readable `reason`
with `toFixed`, which stays shell (see the module header).
-/
def classifyClusterLabel (c : Cluster) : String :=
  let sorted := c.stays.mergeSort (fun a b => decide (a.startTs ≤ b.startTs))
  let firstTs := (sorted.headD default).startTs
  let lastTs := (sorted.getLastD default).endTs
  let dateSpanDays := Float.ofInt (lastTs - firstTs) / 86400
  let uniqueDays := Float.ofNat (uniqueDayCount c.stays c.centroidLon)
  let totalHours := Float.ofInt c.totalDwellSec / 3600
  let overnightHours := sumHourBucket c.stays c.centroidLon 0 6
  let wkdayDaytime := weekdayDaytimeHours c.stays c.centroidLon
  let overnightFrac := overnightHours / max totalHours 1
  let wkdayDaytimeFrac := wkdayDaytime / max totalHours 1
  if decide (dateSpanDays ≥ 30) && decide (uniqueDays ≥ 20) && decide (overnightFrac ≥ 0.25) then "home"
  -- Long-running work (a regular office).
  else if decide (dateSpanDays ≥ 28) && decide (uniqueDays ≥ 10)
          && decide (wkdayDaytimeFrac ≥ 0.35) && decide (overnightFrac < 0.1) then "work"
  -- Trip-work: weekday-daytime presence during a contained window, so a
  -- recurring "frequent" spot is not swallowed.
  else if decide (dateSpanDays ≥ 5) && decide (dateSpanDays ≤ 21) && decide (uniqueDays ≥ 5)
          && decide (wkdayDaytimeFrac ≥ 0.3) && decide (overnightFrac < 0.15) then "work"
  else if decide (dateSpanDays ≤ 21) && decide (overnightFrac ≥ 0.15) then "hotel"
  else if decide (uniqueDays ≥ 5) && decide (dateSpanDays ≥ 30) then "frequent"
  else if decide (uniqueDays ≤ 2) then "one-off"
  else "other"

/--
At most one Home and one Work across the user's clusters, then a "Stay" tier.

* Home — most deep-night hours, given ≥30 days span, ≥20 unique days and ≥30
  sleep-hours. Singular even if two clusters look home-like.
* Work — most weekday-daytime hours (excluding Home), given ≥20 such hours;
  a café visited 8× over two months gives ~6 h and does not qualify.
* Stay — deep-night presence without enough history to be Home: parents'
  flats, friends' apartments, multi-night hotels.
-/
def assignDisplayNames (clusters : List Cluster) : List (Int × String) := Id.run do
  let mut names : Array (Int × String) := #[]
  let homeCandidates := (clusters.map (fun c =>
      let sorted := c.stays.mergeSort (fun a b => decide (a.startTs ≤ b.startTs))
      let span := Float.ofInt ((sorted.getLastD default).endTs - (sorted.headD default).startTs) / 86400
      (c, span, uniqueDayCount c.stays c.centroidLon, sleepHoursOf c))).filter
      (fun (_, span, days, sleep) => decide (span ≥ 30) && days ≥ 20 && decide (sleep ≥ 30))
    |>.mergeSort (fun a b => decide (b.2.2.2 ≤ a.2.2.2))
  let homeId := (homeCandidates.head?).map (fun x => x.1.id)
  match homeId with
  | some id => names := names.push (id, "Home")
  | none => pure ()
  let workCandidates := ((clusters.filter (fun c => homeId != some c.id)).map
      (fun c => (c, weekdayDaytimeHours c.stays c.centroidLon))).filter
      (fun (_, h) => decide (h ≥ 20))
    |>.mergeSort (fun a b => decide (b.2 ≤ a.2))
  match (workCandidates.head?).map (fun x => x.1.id) with
  | some id => names := names.push (id, "Work")
  | none => pure ()
  for c in clusters do
    if names.any (fun (id, _) => id == c.id) then continue
    if decide (sleepHoursOf c ≥ 5) && uniqueDayCount c.stays c.centroidLon ≥ 2 then
      names := names.push (c.id, STAY_DISPLAY_NAME)
  return names.toList

/--
The dominant amenity name from a weighted vote (typically dwell seconds), or
`none` when the evidence is sparse or contested — the caller then falls back
to per-visit OSM lookup.
-/
def pickWinningAmenity (votes : List (String × Float)) (minWeight minFraction : Float) : Option String := Id.run do
  if votes.isEmpty then return none
  let mut total : Float := 0
  let mut winner := ""
  let mut winnerWeight : Float := 0
  for (name, w) in votes do
    total := total + w
    if decide (w > winnerWeight) then
      winnerWeight := w
      winner := name
  if decide (total < minWeight) then return none
  if decide (winnerWeight / total < minFraction) then return none
  return some winner

/-! ## Cluster splitting -/

/-- Minimum distinct visit-days a split-off lobe must have. Two: a place
    visited on two separate days has recurred; one stray visit has not. -/
def SPLIT_MIN_LOBE_DAYS : Nat := 2
/-- The two lobes must be separated by an empty band at least this wide —
    the bimodality test. A genuine daytime and evening mode have a real gap;
    k-means cutting one continuous spread leaves the halves touching. -/
def SPLIT_MIN_TIME_GAP_HOURS : Float := 1.5
/-- A split is kept only when the two lobes sit at spatially distinct places.
    Below this it is ONE place visited at two times of day (a home arrived in
    the evening, left in the morning) and must not split. -/
def SPLIT_MARGIN_M : Float := 30
def KMEANS_MAX_ITERS : Nat := 50

/-- Build a cluster from stays — dwell-weighted centroid, like `clusterStays`.
    `id` is a placeholder; the caller re-assigns it. -/
private def clusterFromStays (stays : List Stay) : Cluster :=
  let (total, lat, lon) := stays.foldl (fun (t, la, lo) s =>
    (t + s.durationSec, la + s.centroidLat * Float.ofInt s.durationSec,
     lo + s.centroidLon * Float.ofInt s.durationSec)) (0, 0, 0)
  ⟨0, lat / Float.ofInt total, lon / Float.ofInt total, stays, total⟩

private def sqDist (a b : Float × Float) : Float :=
  let d1 := a.1 - b.1
  let d2 := a.2 - b.2
  d1 * d1 + d2 * d2

private def meanVec (pts : Array (Float × Float)) (assign : Array Nat) (label : Nat)
    (fallback : Float × Float) : Float × Float := Id.run do
  let mut s1 : Float := 0
  let mut s2 : Float := 0
  let mut count : Nat := 0
  for i in [0 : pts.size] do
    if assign[i]! != label then continue
    count := count + 1
    s1 := s1 + pts[i]!.1
    s2 := s2 + pts[i]!.2
  if count == 0 then return fallback
  return (s1 / Float.ofNat count, s2 / Float.ofNat count)

/-- Deterministic 2-means: initialise on the farthest-apart pair, then Lloyd
    iterations to convergence. Returns a 0/1 label per point. -/
private def kmeans2 (pts : Array (Float × Float)) : Array Nat := Id.run do
  let n := pts.size
  let mut iA := 0
  let mut iB := 1
  let mut far : Float := -1
  for i in [0 : n] do
    for j in [i + 1 : n] do
      let d := sqDist pts[i]! pts[j]!
      if decide (d > far) then
        far := d
        iA := i
        iB := j
  let mut cA := pts[iA]!
  let mut cB := pts[iB]!
  let mut assign : Array Nat := Array.replicate n 0
  for _ in [0 : KMEANS_MAX_ITERS] do
    let mut changed := false
    for i in [0 : n] do
      let a := if decide (sqDist pts[i]! cA ≤ sqDist pts[i]! cB) then 0 else 1
      if a != assign[i]! then
        assign := assign.set! i a
        changed := true
    cA := meanVec pts assign 0 cA
    cB := meanVec pts assign 1 cB
    if !changed then break
  return assign

/-- Width, in hours, of the smaller of the two empty bands separating the
    lobes around the 24-hour circle. Large for a genuine daytime/evening
    bimodality; near zero when k-means has merely cut one continuous spread. -/
private def minBetweenLobeGapHours (stays : List Stay) (assign : Array Nat) (lon : Float) : Float := Id.run do
  let order := (stays.zipIdx.map (fun (s, i) =>
    (localSolarHourFractional ((s.startTs + s.endTs) / 2) lon, assign[i]!))).mergeSort
    (fun a b => decide (a.1 ≤ b.1))
  let arr := order.toArray
  let mut minGap : Float := 24
  for i in [0 : arr.size] do
    let cur := arr[i]!
    let nxt := arr[(i + 1) % arr.size]!
    if cur.2 == nxt.2 then continue
    let gap := wrapTo (nxt.1 - cur.1) 24
    if decide (gap < minGap) then minGap := gap
  return minGap

/--
Split a cluster that conflates two co-located places — most often a daytime
café and an evening residence under `CLUSTER_RADIUS_M` apart, fused by
`clusterStays`.

Time-of-day is the separating signal: visits are clustered by their circular
time-of-day ALONE (midpoint solar hour as a unit-circle angle), then the fit
must clear all three gates — bimodality, both lobes substantial, and the lobes
spatially distinct. Clustering on time rather than joint (space, time) is
deliberate: a residence's own ~100 m of indoor-GPS scatter, standardised into
a joint feature space, overpowers the café/residence time gap on real data.
Space earns its place as gate 3, not as a clustering dimension.

One binary split per cluster; no recursion.
-/
def splitCluster (cluster : Cluster) : List Cluster := Id.run do
  let stays := cluster.stays
  -- Can't form two ≥SPLIT_MIN_LOBE_DAYS lobes without twice that many days.
  if uniqueDayCount stays cluster.centroidLon < 2 * SPLIT_MIN_LOBE_DAYS then return [cluster]
  -- Circular embedding, so 23:00 and 01:00 sit near each other.
  let tfeats := (stays.map (fun s =>
    let ang := (localSolarHourFractional ((s.startTs + s.endTs) / 2) cluster.centroidLon / 24)
               * 2 * 3.141592653589793
    (Float.cos ang, Float.sin ang))).toArray
  let assign := kmeans2 tfeats
  let lobeA := (stays.zipIdx.filter (fun (_, i) => assign[i]! == 0)).map (·.1)
  let lobeB := (stays.zipIdx.filter (fun (_, i) => assign[i]! == 1)).map (·.1)
  if lobeA.isEmpty || lobeB.isEmpty then return [cluster]
  let a := clusterFromStays lobeA
  let b := clusterFromStays lobeB
  let spatialGap := haversineMeters a.centroidLat a.centroidLon b.centroidLat b.centroidLon
  -- Gate 1 — a genuine bimodality, not k-means cutting one spread of times.
  if decide (minBetweenLobeGapHours stays assign cluster.centroidLon < SPLIT_MIN_TIME_GAP_HOURS) then
    return [cluster]
  -- Gate 2 — each lobe is a place, not a stray visit.
  if uniqueDayCount lobeA cluster.centroidLon < SPLIT_MIN_LOBE_DAYS
     || uniqueDayCount lobeB cluster.centroidLon < SPLIT_MIN_LOBE_DAYS then return [cluster]
  -- Gate 3 — the two lobes are at spatially distinct places.
  if decide (spatialGap < SPLIT_MARGIN_M) then return [cluster]
  return [a, b]

/-- Filter low-accuracy fixes, detect stays, cluster, split, then re-id and
    sort by dwell. Ids are assigned BEFORE the sort, as in the TS. -/
def detectFocusPlaces (points : List RawPoint) : List Stay × List Cluster :=
  let filtered := points.filter (fun p =>
    match p.accuracy with | none => true | some a => decide (a ≤ ACCURACY_FILTER_M))
  let stays := detectStays filtered
  let split := (clusterStays stays).flatMap splitCluster
  let reIded := split.zipIdx.map (fun (c, i) => { c with id := Int.ofNat i + 1 })
  (stays, reIded.mergeSort (fun a b => decide (b.totalDwellSec ≤ a.totalDwellSec)))

/-! ## Parity with Node/V8 (`lean/experiments/focus-places-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

/-- 2026-05-11 00:00:00 UTC — a Monday. -/
private def DAY0 : Int := 1778457600
private def HOME_LAT : Float := 51.5205
private def HOME_LON : Float := -0.1275

/-! ### Solar time -/

#guard localSolarHour DAY0 0 == 0
#guard localSolarHour (DAY0 + 9 * 3600) 0 == 9
#guard localSolarHour (DAY0 + 9 * 3600) (-0.1275) == 8
#guard localSolarHour (DAY0 + 9 * 3600) (-122) == 0
#guard localSolarHour (DAY0 + 9 * 3600) 139 == 18
#guard approx (localSolarHourFractional (DAY0 + 9 * 3600) 0) 9
#guard approx (localSolarHourFractional (DAY0 + 9 * 3600) (-0.1275)) 8.9915000000000003
#guard approx (localSolarHourFractional (DAY0 + 9 * 3600) (-122)) 0.86666666666666670
#guard approx (localSolarHourFractional (DAY0 + 9 * 3600) 139) 18.266666666666666
#guard approx (localSolarHourFractional (DAY0 + 23 * 3600 + 1800) 15) 0.5
-- Sub-minute resolution: the fractional form reads seconds, the floored one
-- does not.
#guard approx (localSolarHourFractional (DAY0 + 90) (-0.1275)) 0.016500000000000150
#guard localSolarDayOfWeek (DAY0 + 12 * 3600) HOME_LON == 0
#guard (List.range 8).map (fun d => localSolarDayOfWeek (DAY0 + Int.ofNat d * 86400 + 12 * 3600) HOME_LON)
       == [0, 1, 2, 3, 4, 5, 6, 0]
-- The lon offset can push an instant into the previous/next solar day.
#guard localSolarDayOfWeek (DAY0 + 23 * 3600 + 1800) 15 == 1

/-! ### Stay detection -/

private def stationaryPoints (lat lon : Float) (from_ to : Int) (accuracy : Option Float := some 20) :
    List RawPoint := Id.run do
  let mut out : Array RawPoint := #[]
  let mut t := from_
  while t < to do
    out := out.push ⟨t, lat, lon, accuracy⟩
    t := t + 300
  return out.toList

#guard match detectStays (stationaryPoints HOME_LAT HOME_LON (DAY0 + 3600) (DAY0 + 3600 + 5400)) with
       | [s] => s.startTs == DAY0 + 3600 && s.endTs == DAY0 + 8700 && s.pointCount == 18
                && s.durationSec == 5100 && s.centroidLat == HOME_LAT && s.centroidLon == HOME_LON
       | _ => false
-- Under FOCUS_VISIT_MIN_S, a single point, and nothing at all.
#guard (detectStays (stationaryPoints HOME_LAT HOME_LON DAY0 (DAY0 + 400))).length == 0
#guard (detectStays [⟨DAY0, HOME_LAT, HOME_LON, some 10⟩]).length == 0
#guard (detectStays []).length == 0
-- A jump beyond STAY_RADIUS_M breaks the window into two stays.
#guard match detectStays (stationaryPoints HOME_LAT HOME_LON (DAY0 + 3600) (DAY0 + 7200)
                          ++ stationaryPoints (HOME_LAT + 0.02) HOME_LON (DAY0 + 9000) (DAY0 + 12600)) with
       | [a, b] => a.startTs == DAY0 + 3600 && a.durationSec == 3300
                   && b.startTs == DAY0 + 9000 && b.durationSec == 3300
                   && approx b.centroidLat 51.540500000000002
       | _ => false

/-! ### Clustering -/

private def mkStay (lat lon : Float) (startTs durationSec : Int) : Stay :=
  ⟨startTs, startTs + durationSec, lat, lon, 10, durationSec⟩

#guard match clusterStays [mkStay HOME_LAT HOME_LON (DAY0 + 3600) 3600,
                           mkStay (HOME_LAT + 0.0005) HOME_LON (DAY0 + 86400) 7200,
                           mkStay (HOME_LAT + 0.02) HOME_LON (DAY0 + 2 * 86400) 3600] with
       | [a, b] => a.id == 1 && a.stays.length == 2 && a.totalDwellSec == 10800
                   && approx a.centroidLat 51.520833333333336
                   && b.id == 2 && b.stays.length == 1 && b.totalDwellSec == 3600
       | _ => false
#guard (clusterStays []).length == 0

/-! ### Day counting and sleep -/

private def nightStays : List Stay :=
  [mkStay HOME_LAT HOME_LON (DAY0 + 22 * 3600) (8 * 3600),
   mkStay HOME_LAT HOME_LON (DAY0 + 86400 + 22 * 3600) (8 * 3600),
   mkStay HOME_LAT HOME_LON (DAY0 + 2 * 86400 + 13 * 3600) (5 * 3600)]

private def nightCluster : Cluster :=
  ⟨1, HOME_LAT, HOME_LON, nightStays, nightStays.foldl (fun a s => a + s.durationSec) 0⟩

#guard uniqueDayCount nightStays HOME_LON == 3
-- The solar offset moves the day boundary: at lon 139 two stays share a day.
#guard uniqueDayCount nightStays 139 == 2
#guard approx (sleepHoursOf nightCluster) 16
#guard approx (sleepHoursFromFitbit nightStays
        [(DAY0 + 23 * 3600, DAY0 + 30 * 3600), (DAY0 + 86400 + 23 * 3600, DAY0 + 86400 + 29 * 3600)]) 13
#guard sleepHoursFromFitbit nightStays [] == 0

/-! ### Hour profiles -/

#guard serializeHourProfile (hourProfileForRange (DAY0 + 9 * 3600) (DAY0 + 12 * 3600) HOME_LON)
       == "0,0,0,0,0,0,0,0,143,286,286,286,0,0,0,0,0,0,0,0,0,0,0,0"
#guard serializeHourProfile (hourProfileOf nightCluster)
       == "89,89,89,89,89,89,0,0,0,0,0,0,22,44,44,44,44,44,0,0,0,44,89,89"
-- A zero-length range still samples its single instant.
#guard serializeHourProfile (hourProfileForRange DAY0 DAY0 HOME_LON)
       == "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1000"
#guard parseHourProfile (some "0,0,0,0,0,0,0,0,143,286,286,286,0,0,0,0,0,0,0,0,0,0,0,0")
       == some [0, 0, 0, 0, 0, 0, 0, 0, 0.143, 0.286, 0.286, 0.286, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
#guard (parseHourProfile none).isNone
#guard (parseHourProfile (some "")).isNone
#guard (parseHourProfile (some "1,2,3")).isNone
#guard (parseHourProfile (some (String.intercalate "," (List.replicate 24 "x")))).isNone
-- JS `Number("")` is 0, so a row of empty fields parses to all zeros.
#guard parseHourProfile (some (String.intercalate "," (List.replicate 24 ""))) == some (List.replicate 24 0)

/-! ### Classification -/

private def mkCluster (id : Int) (lat lon : Float) (stays : List Stay) : Cluster :=
  ⟨id, lat, lon, stays, stays.foldl (fun a s => a + s.durationSec) 0⟩

/-- `n` nightly 22:00→06:00 stays on consecutive days. -/
private def nightly (n : Nat) (lat : Float := HOME_LAT) (lon : Float := HOME_LON) (startDay : Nat := 0) : List Stay :=
  (List.range n).map (fun i => mkStay lat lon (DAY0 + Int.ofNat (startDay + i) * 86400 + 22 * 3600) (8 * 3600))

/-- `n` weekday 09:00→17:00 stays, skipping weekends. -/
private def workdays (n : Nat) (lat lon : Float) : List Stay := Id.run do
  let mut out : Array Stay := #[]
  let mut d : Nat := 0
  while out.size < n do
    if localSolarDayOfWeek (DAY0 + Int.ofNat d * 86400 + 12 * 3600) lon ≤ 4 then
      out := out.push (mkStay lat lon (DAY0 + Int.ofNat d * 86400 + 9 * 3600) (8 * 3600))
    d := d + 1
  return out.toList

private def homeC : Cluster := mkCluster 1 HOME_LAT HOME_LON (nightly 40)
private def workC : Cluster := mkCluster 2 51.53 (-0.13) (workdays 25 51.53 (-0.13))

#guard classifyClusterLabel homeC == "home"
#guard classifyClusterLabel workC == "work"
#guard classifyClusterLabel (mkCluster 3 40.7 (-74) (nightly 6 40.7 (-74))) == "hotel"
#guard classifyClusterLabel (mkCluster 4 48.8 2.3 [mkStay 48.8 2.3 (DAY0 + 13 * 3600) 7200]) == "one-off"
#guard classifyClusterLabel (mkCluster 5 51.51 (-0.12)
        ((List.range 8).map (fun i => mkStay 51.51 (-0.12) (DAY0 + Int.ofNat i * 5 * 86400 + 13 * 3600) 5400)))
       == "frequent"
#guard classifyClusterLabel (mkCluster 6 51.51 (-0.12)
        ((List.range 4).map (fun i => mkStay 51.51 (-0.12) (DAY0 + Int.ofNat i * 2 * 86400 + 13 * 3600) 5400)))
       == "other"

/-! ### Display names -/

#guard assignDisplayNames [homeC, workC, mkCluster 7 52.1 4.3 (nightly 3 52.1 4.3 5)]
       == [(1, "Home"), (2, "Work"), (7, "Stay")]
#guard assignDisplayNames [homeC] == [(1, "Home")]
-- A handful of afternoon visits earns no name at all.
#guard assignDisplayNames [mkCluster 9 51.51 (-0.12)
        ((List.range 4).map (fun i => mkStay 51.51 (-0.12) (DAY0 + Int.ofNat i * 2 * 86400 + 13 * 3600) 5400))]
       == []

/-! ### `pickWinningAmenity` -/

#guard (pickWinningAmenity [] 100 0.5).isNone
#guard pickWinningAmenity [("Cafe A", 900)] 100 0.5 == some "Cafe A"
-- Too little total evidence to commit.
#guard (pickWinningAmenity [("Cafe A", 90)] 100 0.5).isNone
-- A contested vote returns none so the runtime OSM picker stays in charge.
#guard (pickWinningAmenity [("Cafe A", 520), ("Cafe B", 480)] 100 0.6).isNone
#guard pickWinningAmenity [("Cafe A", 520), ("Cafe B", 480)] 100 0.5 == some "Cafe A"
#guard pickWinningAmenity [("Cafe A", 300), ("Cafe B", 700)] 100 0.5 == some "Cafe B"
-- An exact tie keeps the first-seen name (strict `>` in the argmax).
#guard pickWinningAmenity [("A", 500), ("B", 500)] 100 0.5 == some "A"

/-! ### `splitCluster` -/

/-- A café visited at ~13:00 and a residence at ~21:00, ~45 m apart. -/
private def cafeResidence : Cluster :=
  mkCluster 1 (HOME_LAT + 0.0002) HOME_LON
    ((List.range 4).flatMap (fun d =>
      [mkStay HOME_LAT HOME_LON (DAY0 + Int.ofNat d * 86400 + 13 * 3600) 3600,
       mkStay (HOME_LAT + 0.0004) HOME_LON (DAY0 + Int.ofNat d * 86400 + 21 * 3600) 7200]))

#guard match splitCluster cafeResidence with
       | [a, b] => approx a.centroidLat 51.520499999999998 && a.totalDwellSec == 14400 && a.stays.length == 4
                   && approx b.centroidLat 51.520899999999997 && b.totalDwellSec == 28800 && b.stays.length == 4
       | _ => false
-- Gate 3: ONE home visited both evening and morning is temporally bimodal but
-- its lobes are ~2 m apart, so it must not split.
#guard (splitCluster (mkCluster 1 HOME_LAT HOME_LON
        ((List.range 4).flatMap (fun d =>
          [mkStay HOME_LAT HOME_LON (DAY0 + Int.ofNat d * 86400 + 21 * 3600) 3600,
           mkStay (HOME_LAT + 0.00002) HOME_LON (DAY0 + Int.ofNat d * 86400 + 7 * 3600) 3600])))).length == 1
-- Too few distinct days to form two lobes at all.
#guard (splitCluster (mkCluster 1 HOME_LAT HOME_LON (nightly 3))).length == 1
-- Gate 1: a continuous spread of visit times — k-means cuts it, but the two
-- halves still touch, so there is no empty band.
#guard (splitCluster (mkCluster 1 HOME_LAT HOME_LON
        ((List.range 6).map (fun d =>
          mkStay HOME_LAT HOME_LON (DAY0 + Int.ofNat d * 86400 + Int.ofNat (10 + d) * 3600) 3600)))).length == 1

/-! ### `detectFocusPlaces` -/

private def dayPoints : List RawPoint :=
  (List.range 3).flatMap (fun d =>
    stationaryPoints HOME_LAT HOME_LON (DAY0 + Int.ofNat d * 86400) (DAY0 + Int.ofNat d * 86400 + 6 * 3600)
    ++ stationaryPoints 51.53 (-0.13) (DAY0 + Int.ofNat d * 86400 + 9 * 3600)
         (DAY0 + Int.ofNat d * 86400 + 17 * 3600))

-- Ids are assigned before the dwell sort, so the busier cluster keeps id 2.
#guard match detectFocusPlaces dayPoints with
       | (stays, [a, b]) => stays.length == 6
                            && a.id == 2 && a.totalDwellSec == 85500 && a.stays.length == 3
                            && b.id == 1 && b.totalDwellSec == 63900 && b.stays.length == 3
       | _ => false
-- Fixes worse than ACCURACY_FILTER_M never reach stay detection.
#guard match detectFocusPlaces (stationaryPoints HOME_LAT HOME_LON DAY0 (DAY0 + 5400) (some 500)) with
       | (stays, _) => stays.length == 0

end Verified.Geo.FocusPlaces
