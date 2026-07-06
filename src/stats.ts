/**
 * Tiny pure stats for the `/internal/recovery` endpoint: the latest value of a
 * daily metric plus a baseline (mean + sd of the preceding days). Nulls (no-wear
 * nights) are dropped. Kept separate + pure so it's unit-tested without a DB and
 * works under the route test's select/where/execute mock.
 */

export interface Stat {
	/** Most recent (by date) non-null value. */
	latest: number;
	/** Mean of the days BEFORE the latest (the reference the latest is judged against). */
	mean: number;
	/** Standard deviation of those baseline days. */
	sd: number;
	/** Number of baseline days (the caller can require e.g. n>=7 before trusting a z-score). */
	n: number;
}

export function latestAndBaseline(series: { date: string; value: number | null }[]): Stat | null {
	const clean = series
		.filter((s): s is { date: string; value: number } => s.value != null)
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	if (clean.length === 0) return null;

	const latest = clean[clean.length - 1].value;
	const base = clean.slice(0, -1).map((s) => s.value);
	if (base.length === 0) return { latest, mean: latest, sd: 0, n: 0 };

	const mean = base.reduce((a, b) => a + b, 0) / base.length;
	const variance = base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length;
	return { latest, mean, sd: Math.sqrt(variance), n: base.length };
}
