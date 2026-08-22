#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Connection` from the production
 * TypeScript.
 *
 * `/api/me` reports whether Nextcloud and Fitbit are linked. Both statuses come
 * from the same three-line shape over different tables, and the interesting
 * part is what it does with a value it does not recognise: it FALLS THROUGH to
 * `active`. Only the exact string `needs_reauth` counts as broken, so a status
 * a later migration adds — or an empty one — is reported to the user as a
 * working connection.
 *
 * ⚠ Reproduced here rather than imported, because the production functions take
 * a userId and hit the database. The logic is transcribed from
 * `src/nextcloud/credentials.ts` and `src/fitbit/token-manager.ts`, which are
 * byte-for-byte the same rule; if either changes, this file must be re-read
 * against it. That is a weaker guarantee than the generators that import their
 * subject, and it is why the transcription is three lines and quoted exactly.
 *
 * Run: npx tsx lean/experiments/connection-refs.mts
 */

/** Verbatim from `getConnectionStatus`, with the row read factored out. */
function statusOf(row: { status: string } | undefined): string {
	if (!row) return "not_linked";
	if (row.status === "needs_reauth") return "needs_reauth";
	return "active";
}

console.log("--- statusOf(row) ---");
for (const stored of [undefined, "needs_reauth", "active", "", "revoked", "NEEDS_REAUTH"] as const) {
	const row = stored === undefined ? undefined : { status: stored };
	const out = statusOf(row);
	// The legacy boolean `/api/me` still sends: `status !== "not_linked"`.
	console.log(`status=${JSON.stringify(stored)}: ${out}  linked=${out !== "not_linked"}`);
}
