/** A `DATE` cell as a `YYYY-MM-DD` string.
 *
 * The mariadb connector returns `DATE` columns as JS `Date` objects (built at
 * *local* midnight — the pool sets no `dateStrings`), not the `YYYY-MM-DD`
 * strings that `db/tables.ts` types them as and that every date comparison in
 * the codebase assumes. Left un-normalised, a `Date` breaks in two ways: a
 * string comparison (`row.date >= floor`) coerces the string bound to `NaN` and
 * silently drops the row, and `String(date).slice(0, 10)` prints
 * `"Thu Jul 17"` instead of `2026-07-17`. Normalise from the local components
 * the connector built the `Date` from (not `toISOString`, which would shift the
 * day in a non-UTC process). Tolerates a real string too, in case the pool ever
 * sets `dateStrings`.
 */
export function ymd(v: string | Date): string {
	if (typeof v === "string") return v.slice(0, 10);
	const y = v.getFullYear();
	const m = String(v.getMonth() + 1).padStart(2, "0");
	const d = String(v.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
