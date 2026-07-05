/**
 * Share-token feature.
 *
 * One token per user (PRIMARY KEY on user_id) gives an unauthenticated
 * recipient read access to the timeline data for the user's last N
 * days. Token rotation = DELETE + INSERT: the old token's row is
 * gone, so subsequent requests with the old token miss the DB lookup
 * and 404. "Revoke" is the same as "rotate without recreating".
 *
 * The public read endpoint authenticates strictly on token presence
 * and validity (row exists, not soft-deleted). It does NOT issue
 * a session cookie or carry the bearer through any other route.
 */

import { randomBytes } from "node:crypto";

/** 32 random bytes -> 43 base64url chars. Big enough to be
 *  un-guessable (256 bits of entropy) and short enough to fit in a
 *  pastable URL. */
export function generateShareToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Compose the public URL that gets sent to the recipient. */
export function buildShareUrl(baseUrl: string, token: string): string {
	const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${trimmed}/share/${token}`;
}

/** Inclusive [from, to] date range for a share with this `days_back`
 *  setting. `today` is the most recent date the recipient should see
 *  (typically the user's local today). Returns null for the
 *  degenerate case `days_back <= 0`, which the caller should treat
 *  as "share is disabled". */
export function shareableDateRange(today: string, daysBack: number): { from: string; to: string } | null {
	if (daysBack <= 0) return null;
	// Parse YYYY-MM-DD without a timezone shift. Both `today` and the
	// computed `from` are pure date strings; no time-of-day arithmetic
	// matters here.
	const [y, m, d] = today.split("-").map(Number);
	const todayUtc = new Date(Date.UTC(y, m - 1, d));
	const fromUtc = new Date(todayUtc.getTime() - (daysBack - 1) * 86400_000);
	const fmt = (dt: Date): string =>
		`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
	return { from: fmt(fromUtc), to: today };
}

/** Lower bound on a share window. */
export const SHARE_DAYS_MIN = 1;
/** Upper bound on a share window (matches the settings UI's input max). */
export const SHARE_DAYS_MAX = 365;

/** Validate + clamp a requested share day-window to `[SHARE_DAYS_MIN,
 *  SHARE_DAYS_MAX]`. Returns null when the input is not a finite number,
 *  so the caller can decide whether to default (create) or reject
 *  (update). Floors fractional values. */
export function clampShareDaysBack(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(SHARE_DAYS_MIN, Math.min(SHARE_DAYS_MAX, Math.floor(value)));
}
