/**
 * CRUD for share_tokens. One row per user; rotation is DELETE +
 * INSERT so a leaked old token immediately stops working.
 */

import { db } from "../db/pool.js";
import { generateShareToken } from "./token.js";

export interface ShareTokenRow {
	user_id: string;
	token: string;
	days_back: number;
	created_at: Date;
	last_accessed_at: Date | null;
}

/** Look up the active share token for this user, or null. */
export async function getShareForUser(userId: string): Promise<ShareTokenRow | null> {
	const row = await db().selectFrom("share_tokens").selectAll().where("user_id", "=", userId).executeTakeFirst();
	return row ?? null;
}

/** Look up by token (the public-read auth path). Returns null if no
 *  such token exists. */
export async function getShareByToken(token: string): Promise<ShareTokenRow | null> {
	const row = await db().selectFrom("share_tokens").selectAll().where("token", "=", token).executeTakeFirst();
	return row ?? null;
}

/** Create or rotate the user's share token. Returns the new row.
 *  Idempotent w.r.t. the row's existence — always returns a fresh
 *  token, and any previous one is gone after this call. */
export async function rotateShareForUser(userId: string, daysBack: number): Promise<ShareTokenRow> {
	const token = generateShareToken();
	// MariaDB doesn't have REPLACE-RETURNING; do DELETE + INSERT in
	// a single transaction so a concurrent read can't see an empty
	// state mid-rotation.
	await db()
		.transaction()
		.execute(async (trx) => {
			await trx.deleteFrom("share_tokens").where("user_id", "=", userId).execute();
			await trx.insertInto("share_tokens").values({ user_id: userId, token, days_back: daysBack }).execute();
		});
	const row = await db().selectFrom("share_tokens").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
	return row;
}

/** Change the day-window of the user's EXISTING share without rotating
 *  the token — the link stays valid, the recipient simply sees a
 *  different number of days. Returns the updated row, or null when the
 *  user has no active share to update (so the caller can 404 rather than
 *  silently create nothing). */
export async function updateShareDaysForUser(userId: string, daysBack: number): Promise<ShareTokenRow | null> {
	await db().updateTable("share_tokens").set({ days_back: daysBack }).where("user_id", "=", userId).execute();
	return getShareForUser(userId);
}

/** Revoke the user's share token (DELETE if present). */
export async function revokeShareForUser(userId: string): Promise<void> {
	await db().deleteFrom("share_tokens").where("user_id", "=", userId).execute();
}

/** Bump last_accessed_at on a token row. Fire-and-forget; if it
 *  fails (lock contention, transient), the read still served. */
export async function touchShareLastAccessed(token: string): Promise<void> {
	try {
		await db().updateTable("share_tokens").set({ last_accessed_at: new Date() }).where("token", "=", token).execute();
	} catch (e) {
		console.warn("touchShareLastAccessed failed:", e);
	}
}
