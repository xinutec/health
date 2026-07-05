# Timezone handling

How the system handles timestamps across data sources with differing
timezone semantics. Two data sources, three distinct timezone concepts.

## Data sources

### PhoneTrack (Nextcloud)

- Stores **UTC unix timestamps** (seconds since epoch).
- Owntracks sends UTC unix timestamps; PhoneTrack's PHP backend keeps
  them in UTC.
- Timestamp interpretation is unambiguous — no tz needed at read time.

> Note for implementers: a stale test at `tests/timezone.test.ts:27-61`
> documents the opposite claim ("PhoneTrack stores timestamps as unix
> epoch but the values represent LOCAL time"). That comment is wrong.
> Empirical verification: PhoneTrack fixes fetched live during a real
> trip have ISO-Z timestamps that match true UTC moments
> (e.g. `20:00:31Z` at lat 51.54, lon -0.13 = central London arrival
> at 21:00 BST). The downstream `dateBoundsUtc(date, tz)` consumer also
> treats them as true UTC and produces correct segments. Delete that
> test as part of implementation.

### Fitbit

- API returns timestamps as wall-clock **strings without timezone info**
  (e.g. `"22:39:00"`).
- The wall-clock reflects the tz the **watch was in at the moment of
  recording**, not "the user's tz" in any abstract sense.
- The watch's tz updates automatically from its connected phone (cell
  tower-based location). Travel days can therefore have rows recorded
  in one tz, then more rows recorded in another tz after the watch
  catches up.
- Fitbit's `/profile.json` endpoint returns `timezone` — but that's
  where the watch *is now*, not where it was historically. Their own UI
  uses this current profile tz to interpret all historical wall-clocks,
  which is wrong across tz transitions.
- We store wall-clocks as DATETIME and require an out-of-band tz to
  interpret each row.

## Three timezone concepts

These were conflated by older code. They are distinct:

1. **Display / day-boundary tz** — the browser's tz, sent as a query
   parameter on each API request. Used to compute "what UTC range does
   'today' cover for this user." Drives `dateBoundsUtc(date, tz)` in
   `src/geo/timezone.ts`.

2. **Recording tz** — the watch's tz at the moment of recording.
   Property of an individual Fitbit row. Must be known to convert that
   row's wall-clock to UTC unix. Stored per-row in the new `tz` column
   on each Fitbit intraday table.

3. **Residence tz** (`home_tz`) — where the user normally lives.
   Derived from the user's `Home` focus_place centroid via offline
   `tz-lookup(lat, lon)`. Used as a fallback when row-tz can't be
   inferred. Stored once per user in `sync_state`, refreshed when
   focus_places is rebuilt.

The bug previously known as "viewing yesterday's walk shows Driving"
was caused by passing the display tz where the recording tz was needed.

## Per-row `tz` column

Each Fitbit table that stores a wall-clock has `tz VARCHAR(64) NULL`.
NULL means "not inferred yet" and forces an explicit fallback at read
time. A sentinel default would silently mislabel.

In scope (read by the velocity pipeline today):
- `steps_intraday`
- `heart_rate_intraday`
- `sleep_stages`
- `sleep` (added in migration v30 — `start_time`/`end_time` are
  device-local DATETIMEs; the new `tz` column disambiguates).

Deferred — explicitly listed so future work knows the gap:
- `spo2_intraday.ts`
- `daily_activity` — date-only, no intraday wall-clock.
- `devices.last_sync_time`

## Write path (sync)

Three forward-sync functions write rows with wall-clock timestamps
that need per-row tz:

- `syncSleep` (`sync.ts:215`) — populates the `tz` column on both
  the parent `sleep` row (via `parseSleepLog`) and the per-stage
  `sleep_stages` rows (via `parseSleepStages`). Both derive `tz`
  from the user's TzSource at the sleep start's wall-clock.
- `syncHeartRateIntraday` (`sync.ts:220-221`) — writes
  `heart_rate_intraday`.
- `syncStepsIntraday` (`sync.ts:223-224`) — writes `steps_intraday`.

Other forward-sync calls in `sync.ts:213-233` (`syncDevices`,
`syncActivity`, `syncBody`, `syncSpO2Daily`, `syncHrv`,
`syncBreathingRate`, `syncTemperature`, `syncHeartRateZones`) write
either date-only rows or rows whose timestamps are not affected by
the bug. They get no `TzSource` parameter.

These same three functions are called from inside the
backward-backfill stream callback (`sync.ts:249, 257, 265`). They
cannot distinguish caller intent from their parameter list. The
split is therefore plumbed via an explicit `tzSource` parameter on
each:

```ts
// src/geo/fitbit-tz.ts (new module)
export interface TzSource {
    /** Given a Fitbit wall-clock row, return the inferred recording tz
     *  or null if no signal is available. */
    forWallClock(date: string, time: string): string | null;
}

// Forward sync builds a real source (PhoneTrack fixes + profile.tz)
export async function buildForwardTzSource(args: {
    fixes: RawTrackPoint[];      // PhoneTrack fixes for the sync window
    profileTz: string | null;    // result of /1/user/-/profile.json or null
}): Promise<TzSource>;

// Backward backfill explicitly disables inference at insert time;
// the Phase 3 CLI fills in tz later from a broader PhoneTrack range.
export const NULL_TZ_SOURCE: TzSource = { forWallClock: () => null };
```

Each of the three sync functions gains a final parameter (default
`NULL_TZ_SOURCE` so existing test fixtures don't break). Row-shape
construction differs across the three:

- **Steps**: `parseStepsDataset` at `src/fitbit/sync/steps.ts:18-31`
  exists as a pure function returning `Array<[string, string, number]>`.
  Extend the return type to a 4-tuple
  `[userId, ts, value, tz | null]` (tz in the last position so
  existing tests need only one minor signature change). Add a
  `tzSource: TzSource` parameter; for each row, call
  `tzSource.forWallClock(date, time)` and append the result.
- **HR intraday**: `heartrate.ts:43-74` constructs rows inline at
  `:66` (`dataset.map((d) => [userId, ..., d.value])`). Lift this
  into a new `parseHRDataset` helper for testability and symmetry
  with steps. Same 4-tuple shape.
- **Sleep stages**: `sleep.ts:65-73` builds rows inline inside a
  `for (const stage of log.levels.data)` loop, currently writing one
  `conn.query` per stage (not batched). Lift this into a
  `parseSleepStages` helper that returns the row tuples for the
  whole sleep log, then switch the call site to `conn.batch` (same
  pattern as `steps.ts`). Note this is *not* a pure refactor — the
  insert-call shape changes from N queries to one batched call.
  4-tuple shape: `[userId, logId, ts, stage, duration_seconds, tz]`
  — sleep_stages already has `sleep_log_id` so the row tuple is
  6 fields, not 4. (4-tuple shape applies to steps and HR.)

INSERT then becomes:

```ts
await conn.batch(
    `INSERT INTO steps_intraday (user_id, ts, steps, tz) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       steps = GREATEST(steps, VALUES(steps)),
       tz    = COALESCE(tz, VALUES(tz))`,
    rows,
);
```

### `TzSource` resolution (forward path)

`buildForwardTzSource` returns a `TzSource` whose `forWallClock`:

1. **First pass — PhoneTrack.** Convert the wall-clock to an
   approximate UTC moment using `profileTz` (seed policy: if
   profileTz is null, use the user's `home_tz` if known; else fall
   back to a hardcoded `Europe/Amsterdam` for this user. A
   multi-user future should pass home_tz at TzSource construction
   time so the seed is per-user, not hardcoded.) Binary-search the
   nearest PhoneTrack fix in time within ±6h of the seeded moment.
   If found, return `tzLookup(fix.lat, fix.lon)`. Memoise by rounded
   lat/lon (~3dp = ~100m) since clustered rows map to the same tz.

   Convergence: seed-error of ±2h (profileTz off by typical European
   tz offsets) is well inside the ±6h fix-search window. Seed-error
   of ±14h (theoretical worst) is outside and would fall through to
   step 2.
2. **Second pass — profile.timezone.** If no GPS fix is within ±6h,
   return `profileTz` (may itself be null if Fitbit's profile call
   failed).
3. **Otherwise NULL.** The row gets `tz=NULL` and the read-time
   COALESCE chain handles it.

This "use profileTz as the seed to find a fix, then use the fix's tz"
loop converges in one pass: even if profileTz disagrees with the
fix's tz by ±2h, the ±6h fix-search window absorbs the error.

### Forward-vs-backward orchestration

In `src/sync.ts`:

- **Forward sync** (line ~205 onwards): before calling the four
  sync*Intraday functions, fetch PhoneTrack fixes for the
  `lastSyncDate → today` window, fetch `/1/user/-/profile.json`, build
  a `TzSource` once, pass it to each sync call.
- **Backward backfill**: the `stream.sync` callbacks in
  `runIntradayBackfill` invoke the same functions with no `TzSource`
  (i.e. `NULL_TZ_SOURCE`). Rows go in with `tz=NULL`. Phase 3 CLI
  fills them in.

### Edge cases handled by this split

- **Watch tz changed today, browser is in new tz, dashboard queries
  today.** Forward sync's `TzSource` picks the new tz from
  PhoneTrack — correct.
- **Backfill processes a 2024 date today.** The forward-window
  PhoneTrack fixes don't cover 2024 → no GPS match → without the
  split, profileTz (current watch tz) would get stamped onto every
  2024 row. With the split, tz=NULL goes in instead. The Phase 3 CLI
  later fetches per-week PhoneTrack history for those dates and
  resolves correctly.
- **`lastSyncDate = daysAgo(30)` on first link.** Forward sync's
  PhoneTrack fetch is 30 days, not 1–7. `refresh-focus-places.ts:80-90`
  already chunks per-week — reuse the same chunking helper to keep
  the Nextcloud API hit reasonable. Days within the 30-day window
  that fall outside the PhoneTrack-available range get `profileTz` or
  NULL via the resolution chain above.

UPSERT semantics:

```sql
INSERT INTO steps_intraday (user_id, ts, steps, tz) VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  steps = GREATEST(steps, VALUES(steps)),
  tz    = COALESCE(tz, VALUES(tz))
```

Note: `COALESCE(tz, VALUES(tz))` rather than preserving `tz`
unconditionally. This lets a row first inserted with `tz=NULL` (because
sync ran during a no-GPS window) get upgraded later when GPS catches
up. Once `tz` is non-NULL, normal sync won't change it. The backfill
CLI (see below) bypasses this and writes `tz` directly.

`row.tz` is therefore "set-once except by backfill CLI." A re-sync of a
day where a higher-confidence fix later became available won't upgrade
the row; the backfill CLI does that.

MariaDB 11.8 supports `VALUES()` in `ON DUPLICATE KEY UPDATE` — verified
in `k8s/02-db.yaml` and used throughout the existing sync modules
(`fitbit/sync/devices.ts`, `spo2.ts`, `hrv.ts`, `body.ts`, `sleep.ts`).

## Storage: the three-tier model

Each wall-clock Fitbit table (`heart_rate_intraday`, `steps_intraday`,
`sleep_stages`, `sleep`) carries three tiers, so the read path never has to
re-derive a timezone per row:

1. **`ts` — source.** The verbatim Fitbit wall-clock string. Immutable; never
   reinterpreted. This is the ground truth a future fix can always recompute
   from.
2. **`ts_utc` (DATETIME) — derived.** The instant `ts` denotes, stored UTC by
   convention. Populated at sync time (and by the one-shot backfill CLI) from
   `ts` + the effective tz; `NULL` only for legacy rows the backfill hasn't
   reached. A secondary index `(user_id, ts_utc)` drives the range scan.
3. **`tz` / `tz_source` — provenance.** The tz used to derive `ts_utc` and
   where it came from (`phonetrack` / `home_tz` / `request`), so a wrong
   derivation is auditable and re-backfillable without touching `ts`.

This is "persist algorithmic outputs, but keep the inputs" applied to time:
`ts_utc` is the cached output, `ts` is the recompute source.

## Read path

`loadBiometrics` in `src/geo/velocity.ts` range-filters directly on `ts_utc`
against the `(user_id, ts_utc)` index — no per-row conversion in the hot path:

```ts
.select([sql<string>`DATE_FORMAT(MIN(ts_utc), '%Y-%m-%d %H:%i:00')`.as("ts_utc"), ...])
.where("ts_utc", ">=", startUtcDt)
.where("ts_utc", "<", endUtcDt)
```

The velocity API's `tz` parameter drives `dateBoundsUtc` for the day-range
endpoints; it no longer affects per-row Fitbit interpretation. The old model
(select `tz` per row, then `fitbitTsToUnix(ts, effectiveTz)` and a ±1-day date
pad to absorb the conversion) is gone from the hot path.

### Legacy fallback (`ts_utc IS NULL`)

A small fallback covers rows the backfill hasn't populated. There the
effective tz is still resolved per row and fed to `fitbitTsToUnix`:

```ts
const effectiveTz = row.tz ?? user.home_tz ?? requestTz;
```

- `row.tz` — set at sync time (or by backfill CLI).
- `user.home_tz` — residence tz, loaded once per request from
  `sync_state.home_tz`. Stable per user.
- `requestTz` — the velocity API's `tz` query parameter; last resort when
  neither `row.tz` nor `home_tz` exists (new account, no PhoneTrack history,
  no `Home` cluster identified).

This fallback is the same chain that derives `ts_utc` at write time, so a
straggler row reads identically whether or not its `ts_utc` is populated yet.

## `home_tz` derivation

`assignDisplayNames` (`src/geo/focus-places.ts:328`) returns
`Map<number, string>` mapping cluster id → human-readable name
(e.g. `"Home"`, `"Work"`). After it runs, the
`refresh-focus-places` CLI iterates the clusters and inserts
focus_places rows. The new home_tz write fits inside that same
iteration:

```ts
// Inside the existing withConnection block + transaction,
// after the focus_places batch INSERT, before commit.
const displayNames = assignDisplayNames(result.clusters);
let homeTz: string | null = null;
for (const c of result.clusters) {
    if (displayNames.get(c.id) === "Home") {
        homeTz = tzLookup(c.centroidLat, c.centroidLon);
        break;
    }
}
if (homeTz !== null) {
    await setSyncState(userId, "home_tz", homeTz, conn);  // pass conn
}
// If no Home cluster qualifies this run, leave sync_state.home_tz
// untouched — a transient bad refresh shouldn't wipe the fallback.
```

Refresh happens implicitly on every `refresh-focus-places` run
(weekly or manual). If the user moves house, the next refresh
updates the value.

No reverse-geocode (Nominatim) is involved. `tz-lookup` operates
directly on the centroid coordinates — coordinates → IANA tz in one
offline call.

`setSyncState` / `getSyncState` are currently private helpers in
`src/sync.ts:39-55`. Extract them to a new shared module
`src/db/sync-state.ts` so both `sync.ts` and `refresh-focus-places.ts`
can import them.

**Important — connection scoping.** The current implementation uses
`db()` (the Kysely pool), which checks out a *new* connection on
every call. A `setSyncState` call inside a `withConnection` block
will therefore commit independently of the surrounding
`BEGIN/COMMIT` block. The home_tz write needs to participate in the
focus-places transaction. Extend the extracted helpers with an
optional connection arg:

```ts
// src/db/sync-state.ts
export async function setSyncState(
    userId: string, key: string, value: string,
    conn?: mariadb.Connection,
): Promise<void> {
    if (conn !== undefined) {
        await conn.query(
            `INSERT INTO sync_state (user_id, key_name, value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE value = VALUES(value)`,
            [userId, key, value],
        );
    } else {
        await db().insertInto("sync_state")
            .values({ user_id: userId, key_name: key, value })
            .onDuplicateKeyUpdate({ value })
            .execute();
    }
}
```

Existing callers in `sync.ts` continue to call without the conn
argument (using the pool). The new home_tz write site in
`refresh-focus-places.ts` passes the transaction's `conn` so the
write is rolled back together with the focus_places inserts on
failure.

## Historical backfill (one-shot CLI)

New CLI: `src/cli/backfill-fitbit-tz.ts`. Walks rows where `tz IS NULL`,
oldest first, per user. Per row:

1. Find nearest PhoneTrack GPS fix in time (±6h). If found: tz =
   `tz-lookup` of its lat/lon.
2. Otherwise, carry-forward from the previous day's resolved tz, gap
   bounded to ≤6h.
3. If forward-neighbour and backward-neighbour disagree, day is
   genuinely ambiguous: tz = `home_tz`, log it.
4. Otherwise: tz = `home_tz`.

PhoneTrack fetches are batched per (user, week) to amortise the
Nextcloud API cost — same pattern as `refresh-focus-places.ts`.

`tz-lookup` lookups cached in-memory by rounded coordinates (same as
the sync path).

The CLI is deploy-independent. Can be run any time after the sync
write-path is live.

## Library

**`tz-lookup`** (npm, MIT, offline, embeds a quantised tz polygon
dataset). Single function: `tzLookup(lat, lon) → string` (IANA name).
~1.5MB package, ~150kB of which is the polygon data; entirely
in-memory, no I/O. Sufficient accuracy at the country level; minor
errors near tight tz polygon borders are acceptable.

`geo-tz` was considered. More accurate near borders (full Natural
Earth polygons) but ships ~30MB of data and lazy-loads via filesystem.
Overkill for a single-user-scale deployment in a container, and the
filesystem-lazy-load is brittle under our build.

## Tests

Unit:

- `fitbitTsToUnix` across CEST↔CET transition (March + October dates).
  Verify the fall-back's doubly-occurring 02:30 wall-clock resolves to
  the first occurrence per `Intl.DateTimeFormat` behaviour.
- `fitbitTsToUnix` with both `string` and `Date` input — the mariadb
  driver returns DATETIMEs as `Date` objects in some code paths and as
  strings in the aggregated `DATE_FORMAT` query in
  `src/geo/velocity.ts:53`.
- `tz-lookup` boundary cases: points near NL/BE/FR/UK border polygons.

UPSERT correctness:

- INSERT row with `tz=NULL`; re-INSERT same key with `tz='Europe/Amsterdam'`
  — verify the row's tz is upgraded to Amsterdam.
- Re-INSERT same key with `tz='Europe/London'` — verify the row's tz
  stays Amsterdam (COALESCE preserves first non-NULL value).
- Regression test: catches any "simplification" to `tz = VALUES(tz)`.

Read fallback chain:

- row.tz set → used. row.tz NULL + home_tz set → home_tz used. Both
  NULL → request tz used.
- Determinism test for the backfill CLI: same synthesised travel-day
  fixtures produce the same per-row tz assignment regardless of batch
  ordering.

Integration:

- `loadBiometrics` on a synthesised travel-day dataset (Amsterdam
  morning rows, London afternoon rows) returns step ts that align with
  PhoneTrack segments. Across a London-tz API request, the morning
  walks remain walking, not driving.
- The exact pre-fix regression: same data viewed with `tz=Europe/London`
  in the API request → walking segments stay walking.
- `runIntradayBackfill` invoked on a fixture 2024-date writes `tz=NULL`
  to each row (and specifically NOT today's `profile.timezone`). This
  is the regression that prevents the "stale profileTz stamped onto
  ancient data" anti-pattern.
- `TzSource.forWallClock` determinism: given a fixed PhoneTrack-fix
  set and a fixed wall-clock input, every invocation returns the same
  tz. Verify the memo cache doesn't introduce ordering effects.
- `setSyncState`/`getSyncState` post-extraction: existing sync flows
  (in particular `migrateLegacyBackfillKeys` and the backfill
  cursor updates) continue to behave identically after the helpers
  move to `src/db/sync-state.ts`.
- `refresh-focus-places.ts` end-to-end: given a fixture with a Home
  cluster, after the run completes, `sync_state.home_tz` equals
  `tzLookup(homeCentroidLat, homeCentroidLon)`. Given a fixture
  without a Home cluster, `sync_state.home_tz` is untouched.

## Risks and known limitations

1. **No-GPS travel days.** If a user travels but PhoneTrack was off
   during the day, sync stores `profile.timezone` (current watch tz)
   for all rows. Half the day's rows may be wrong by the offset
   difference. Accepted — no signal to do better. The backfill CLI
   can't help either without GPS.

2. **Profile tz lag.** Watch → phone → Fitbit cloud is a multi-step
   sync. `profile.timezone` may lag actual location by minutes-to-hours.
   The PhoneTrack-tz lookup at sync time is more authoritative and
   tried first; this case only matters when GPS is also silent.

3. **DST transitions.** Spring-forward gives wall-clocks that don't
   exist; Fitbit skips them and we never see one. Fall-back gives
   wall-clocks that occur twice; we map to the first occurrence per
   `Intl.DateTimeFormat` round-tripping. One-hour bounded error,
   once a year per user. Documented, not fixed.

4. **`home_tz` derivation assumes a stable residence.** Users moving
   house is rare; the next `refresh-focus-places` run catches it.

5. **`tzFormatterCache` in `timezone.ts:101` grows unboundedly with
   distinct tz values.** Bounded in practice to the small set of IANA
   names a user passes through. Flag for the multi-user future.

6. **Cross-midnight sleep across tz transitions.** `sleep.dateOfSleep`
   uses Fitbit's view of which date a night belongs to. A night that
   spans an Amsterdam → London transition could land on different dates
   in our system vs the user's mental model. Not in scope; deferred
   with the rest of the `sleep` parent-row work.

7. **`/api/heartrate/intraday` returns the row unchanged.** The route
   at `src/routes/api.ts:125-137` uses `selectAll()` so the new `tz`
   column will be visible to frontend consumers. The dashboard
   currently uses `getUTCHours` on the wall-clock string for display
   (per `time-utils.ts`), which continues to work — display does not
   need tz interpretation. Listed here so a future frontend update
   that *does* convert these timestamps to instants knows to read the
   row's tz, not the browser's.

## Implementation phases

**Phase 1 + 2 — schema, sync, and read path (single deploy).**
Combined to avoid an intermediate state where new rows have tz but
reads ignore it. Steps, in implementation order:

1. **Migration v23**: add `tz VARCHAR(64) NULL` to `steps_intraday`,
   `heart_rate_intraday`, `sleep_stages`. MariaDB instant-add → <1s
   even on populated tables.
2. **Kysely types**: add `tz: string | null` to the three table
   interfaces in `src/db/tables.ts`. Required before any code that
   reads or writes the column can compile.
3. **Dependency**: `tz-lookup` added to `package.json`.
4. **Extract sync-state helpers**: move `getSyncState` and
   `setSyncState` from `src/sync.ts:39-55` to a new shared module
   `src/db/sync-state.ts`. Both helpers gain an **optional
   `conn?: mariadb.Connection` parameter**: when supplied, use
   `conn.query(...)` so the call participates in the caller's
   transaction; when omitted, use `db()` (pool) for backwards
   compatibility. Existing `sync.ts` callers omit the arg. The new
   `refresh-focus-places.ts` `home_tz` write passes `conn` so it
   commits/rolls-back with the surrounding focus_places transaction.
5. **New module `src/geo/fitbit-tz.ts`**: implements `TzSource`,
   `buildForwardTzSource`, `NULL_TZ_SOURCE`, and the binary-search +
   lat/lon-keyed memo cache.
6. **Update row-shape parsers and INSERTs**:
   - `steps.ts`: extend existing `parseStepsDataset` to 4-tuple.
   - `heartrate.ts`: lift the inline `dataset.map(...)` at `:66`
     into a new `parseHRDataset` pure helper; same 4-tuple shape.
   - `sleep.ts`: lift the inline stage-row construction at `:65-73`
     into a new `parseSleepStages` pure helper; same 4-tuple shape.
   All three INSERT statements include `tz` column with
   `ON DUPLICATE KEY UPDATE tz = COALESCE(tz, VALUES(tz))`.
7. **Sync orchestration**: forward sync in `sync.ts` fetches
   PhoneTrack fixes (reusing the weekly chunking from
   `refresh-focus-places.ts:80-90`) and `/1/user/-/profile.json`,
   builds a `TzSource`, passes it to **`syncSleep`,
   `syncHeartRateIntraday`, and `syncStepsIntraday`** (the three
   intraday-or-wall-clock functions). Backward backfill leaves the
   `TzSource` parameter at default (`NULL_TZ_SOURCE`).
8. **`refresh-focus-places.ts`**: when `assignDisplayNames` returns a
   `Home` cluster, write `tzLookup(centroid)` to `sync_state.home_tz`.
   Write happens inside the existing transaction (`:111-144`),
   **passing `conn` to `setSyncState`** so it participates in the
   transaction. A half-failed run won't update `home_tz` to a value
   derived from clusters that didn't get persisted. Skipped entirely
   when `result.clusters.length === 0` (already inside the
   `if (result.clusters.length > 0)` guard).
9. **Read path**: `loadBiometrics` in `velocity.ts:34-105` selects
   `tz` per row. For the per-minute HR aggregate at `:53`, use
   `MAX(tz) AS tz` — mixed-tz buckets are impossible by
   construction (the GROUP BY is on the wall-clock string
   `DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`, and a tz change moves the
   wall-clock discontinuously, so a single bucket can never contain
   timestamps recorded under two different tzs). Load `home_tz` from
   `sync_state` once per request. COALESCE chain applied per row when
   calling `fitbitTsToUnix`.
10. **Delete the misleading test** at `tests/timezone.test.ts:27-61`
    (the "PhoneTrack stores LOCAL time" comment is wrong; see
    verification note in the PhoneTrack section above).
11. **Tests** (per the plan below).

### Deploy sequence (the "existing user" scenario)

This user has ~120 days of `tz=NULL` Fitbit rows already in the DB.
Immediately after the Phase 1+2 deploy:

- New rows being synced get `tz` populated (forward sync path).
- Historical rows still have `tz=NULL`.
- `home_tz` is not yet written to `sync_state` until
  `refresh-focus-places` runs.

If a velocity query lands in that window, the COALESCE chain falls
through to the requestTz fallback → the original bug returns for
historical data.

Mitigation: as **the immediate post-deploy step**, run
`refresh-focus-places` manually for the user. That populates
`home_tz`. From then on, historical queries get the home_tz fallback
(correct for the user's locally-recorded data), and Phase 3 progresses
in the background to fill in per-row tz from PhoneTrack history.

Document this as part of the rollout runbook, not just the design.

**Phase 3 — historical backfill CLI (separate, deploy-independent).**
Run after Phase 1+2 is live and proven. Failures are isolated from
sync correctness.

## Glossary of file references

- `src/geo/timezone.ts` — `fitbitTsToUnix`, `dateBoundsUtc`,
  `isValidTimezone`, `tzFormatterCache`.
- `src/geo/velocity.ts` — `loadBiometrics` (the per-row reader).
- `src/geo/biometrics.ts` — `cadenceForSegment`,
  `correctModeFromCadence` (the consumers whose behaviour broke).
- `src/db/schema.ts` — current migrations through v22.
- `src/db/tables.ts` — Kysely types.
- `src/fitbit/sync/{steps,heartrate,sleep}.ts` — INSERT statements
  to update.
- `src/sync.ts` — orchestration; gains the profile-fetch step.
- `src/cli/refresh-focus-places.ts` — pattern for the backfill CLI
  and the home_tz write site. `assignDisplayNames` is consumed at
  `:115`; the home_tz write fits in the same loop.
- `src/nextcloud/phonetrack.ts` — `fetchTrackPointsRange` for the
  per-sync GPS-fix fetch.
- `src/geo/focus-places.ts:328` — `assignDisplayNames(clusters):
  Map<number, string>` (the cluster id → name map).
- `src/sync.ts:39-55` — private `getSyncState` / `setSyncState`
  helpers to extract to a shared module.
- `src/routes/api.ts:125-137` — `/api/heartrate/intraday` that
  passes the row through `selectAll()`; will surface the new `tz`
  column to the frontend (display continues to work).
