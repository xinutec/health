# Timezone handling

How the system handles timestamps across data sources with differing
timezone semantics. Two data sources, three distinct timezone concepts.

⚠ **THIS DOCUMENT IS THE MODEL. Its `src/**.ts` paths are HISTORICAL** — they
name the TypeScript backend, deleted whole in #975. The prose is kept as the
record of why each decision was taken; **"Where these things live now" at the
foot maps every one of those names to the Rust or Lean symbol that does the work
today.** Read that section before following any path above it (#919).

The model itself did not change with the port, and it is the one thing here to
carry away: **PhoneTrack stores true UTC; Fitbit returns wall-clock strings in
whatever zone the watch was in at recording time.**

## Data sources

### PhoneTrack (Nextcloud)

- Stores **UTC unix timestamps** (seconds since epoch).
- Owntracks sends UTC unix timestamps; PhoneTrack's PHP backend keeps
  them in UTC.
- Timestamp interpretation is unambiguous — no tz needed at read time.


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
   'today' cover for this user." Drives `date_bounds_utc(date, tz)` in
   `rust/backend/src/timezone.rs`.

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

- the sleep writer (`fitbit/sync/sleep.rs`) — populates the `tz` column on both
  the parent `sleep` row (via `parseSleepLog`) and the per-stage
  `sleep_stages` rows (via `parseSleepStages`). Both derive `tz`
  from the user's TzSource at the sleep start's wall-clock.
- the HR intraday writer (`fitbit/sync/heartrate.rs`) — writes
  `heart_rate_intraday`.
- the steps intraday writer (`fitbit/sync/steps.rs`) — writes `steps_intraday`.

The other forward-sync writers (devices, activity, body, SpO2, HRV,
breathing rate, temperature, heart-rate zones) write
either date-only rows or rows whose timestamps are not affected by
the bug. They get no `TzSource` parameter.

These same three functions are called from inside the
backward-backfill stream callback. They
cannot distinguish caller intent from their parameter list. The
split is therefore plumbed via an explicit `tzSource` parameter on
each:

```ts
// the shape as first sketched; today rust/backend/src/fitbit/tz_source.rs
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

- **Steps**: the steps dataset parser (`rust/backend/src/fitbit/sync/`)
  exists as a pure function returning `Array<[string, string, number]>`.
  Extend the return type to a 4-tuple
  `[userId, ts, value, tz | null]` (tz in the last position so
  existing tests need only one minor signature change). Add a
  `tzSource: TzSource` parameter; for each row, call
  `tzSource.forWallClock(date, time)` and append the result.
- **HR intraday**: `heartrate.rs` builds the rows, tz appended per row.
- **Sleep stages**: `sleep.rs` builds the per-stage rows for a whole log,
  each carrying the log's tz.
  Row shape: `[userId, logId, ts, stage, duration_seconds, tz]`
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

In the sync orchestration (`rust/backend/src/fitbit/run.rs`):

- **Forward sync**: before calling the four
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
  PhoneTrack fetch is 30 days, not 1–7. The focus-place refresh already
  chunks per week — the same chunking keeps
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
(`rust/backend/src/fitbit/sync/`).

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

The biometric reader (`rust/backend/src/classification_inputs.rs`) range-filters directly on `ts_utc`
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

`assignDisplayNames` (`lean/Verified/Geo/FocusPlaces.lean`) returns
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

`sync_state::set` / `sync_state::get` (`rust/backend/src/sync_state.rs`) are
the shared helpers, used by the sync and the focus-place refresh alike.

**Important — connection scoping.** The current implementation uses
the pool, which checks out a *new* connection on
every call. A `setSyncState` call inside a `withConnection` block
will therefore commit independently of the surrounding
`BEGIN/COMMIT` block. The home_tz write needs to participate in the
focus-places transaction. Extend the extracted helpers with an
optional connection arg:

```ts
// the shape as first sketched; today rust/backend/src/sync_state.rs
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

The sync calls it with the pool; the focus-place refresh writes `home_tz`
inside its own transaction, so the write rolls back together with the
focus_places inserts on failure.

## Historical backfill (one-shot CLI)

The one-shot backfill (`rust/backend/src/fitbit/backfill_runner.rs`) walks rows where `tz IS NULL`,
oldest first, per user. Per row:

1. Find nearest PhoneTrack GPS fix in time (±6h). If found: tz =
   `tz-lookup` of its lat/lon.
2. Otherwise, carry-forward from the previous day's resolved tz, gap
   bounded to ≤6h.
3. If forward-neighbour and backward-neighbour disagree, day is
   genuinely ambiguous: tz = `home_tz`, log it.
4. Otherwise: tz = `home_tz`.

PhoneTrack fetches are batched per (user, week) to amortise the
Nextcloud API cost — the same pattern as the focus-place refresh.

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

`rust/backend/tests/suite/{timezone,tz_source,backfill,backfill_walk}.rs`.
The test plan this section carried was written for the TypeScript and is in
git history.

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

5. **Cross-midnight sleep across tz transitions.** `sleep.dateOfSleep`
   uses Fitbit's view of which date a night belongs to. A night that
   spans an Amsterdam → London transition could land on different dates
   in our system vs the user's mental model. Not in scope; deferred
   with the rest of the `sleep` parent-row work.

6. **`/api/heartrate/intraday` returns the row unchanged.** The route
   (`rust/backend/src/routes/tables.rs`) returns the row whole, so the `tz`
   column is visible to frontend consumers. The dashboard
   currently uses `getUTCHours` on the wall-clock string for display
   (in the frontend), which continues to work — display does not
   need tz interpretation. Listed here so a future frontend update
   that *does* convert these timestamps to instants knows to read the
   row's tz, not the browser's.

   ⚠ **SETTLED, AND THE OTHER WAY ROUND (#1532).** The frontend update this
   anticipated happened, and what it changed was the WIRE rather than the
   reader. `selectAll()` is gone from `sleep`, `sleep/stages` and
   `heartrate/intraday`: each names its columns and serves the repaired
   instant, `COALESCE(<col>_utc, CONVERT_TZ(<col>, tz, 'UTC'))`, plus `tz`.
   The wall clock does not ship at all, because the JSON renderer stamps every
   DATETIME with a `Z` and cannot tell which have earned it. So the dashboard
   does read the row's tz and not the browser's — but by deriving the label
   from instant + zone, not by converting a wall clock it no longer receives.
   ⚠ TIER 1 IS UNAFFECTED: `ts` is still stored, still immutable, still the
   recompute source. It stopped being a RESPONSE, not a column.

## Where these things live now

⚠ **THE FILE REFERENCES IN THE PROSE ABOVE ARE HISTORICAL.** Every `src/**.ts`
path in this document names the TypeScript backend, which was deleted whole
(#975). They are left as written because the prose around them is a record of
why each decision was taken, and rewriting the paths inline would make a
year-old argument read as current instruction. This section is the map from
those names to the code that does the work today, BY SYMBOL — a symbol survives
a move, a line number does not (#919, #1205).

| the document says | today |
| --- | --- |
| `src/geo/timezone.ts` — `dateBoundsUtc`, `fitbitTsToUnix` | `rust/backend/src/timezone.rs` — `date_bounds_utc`, `wall_clock_to_unix`, `wall_clock_to_utc_string`, `local_date_at`, `local_hour_of` |
| `src/geo/fitbit-tz.ts` — the proposed `TzSource` | `rust/backend/src/fitbit/tz_source.rs` — `ForwardTzSource`, `nearest_fix`, `PolygonLookup`; the DECISION itself is `lean/Verified/FitbitTz.lean` (`decideTz`, `nearestFix`, `FIX_SEARCH_WINDOW_S`) |
| `src/fitbit/sync/{steps,heartrate,sleep}.ts` | `rust/backend/src/fitbit/sync/{steps,heartrate,sleep}.rs` |
| `src/sync.ts` — orchestration | `rust/backend/src/fitbit/{mod,run}.rs` |
| `src/cli/backfill-fitbit-tz.ts` — the one-shot CLI | `rust/backend/src/fitbit/backfill_runner.rs` — `run_intraday_backfill`, `run_range_backfill` |
| `src/db/{schema,tables}.ts` | `rust/backend/src/schema.rs` |
| `src/routes/api.ts` | `rust/backend/src/routes/tables.rs` |
| `src/geo/focus-places.ts` — `assignDisplayNames` | `lean/Verified/Geo/FocusPlaces.lean` — `assignDisplayNames` |
| `src/geo/velocity.ts` — `loadBiometrics` | `rust/backend/src/classification_inputs.rs` (the day's reader) |

⚠ **THE IMPLEMENTATION PLAN THAT STOOD HERE IS GONE, and it is not history worth
keeping.** It was ~90 lines of numbered steps — migrations to add, Kysely types
to edit, a test to delete at `tests/timezone.test.ts:27-61` — every one of them
an INSTRUCTION against a file that no longer exists. They could not be carried
out and they made this document read as a stale line-number sweep for a year.
The work they described was done; the schema, the sync path and the read path
all carry `tz` today.

What survives above is the MODEL, and the model is why this file exists: **
PhoneTrack stores true UTC; Fitbit returns wall-clock strings in whatever zone
the watch was in at recording time.** The port did not change that, and nothing
in the deleted plan was needed to state it.
