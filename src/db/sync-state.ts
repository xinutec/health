/**
 * Per-user key/value persistence in the `sync_state` table.
 *
 * Most callers want the pool-backed variants (no `conn`), which check out a
 * connection from the Kysely pool. When a caller needs the read/write to
 * participate in an outer transaction (so it commits or rolls back together
 * with sibling DB writes), pass the active `conn` and the function uses
 * `conn.query` directly instead of the pool.
 */

import type * as mariadb from "mariadb";
import { db } from "./pool.js";

export async function getSyncState(userId: string, key: string, conn?: mariadb.Connection): Promise<string | null> {
	if (conn !== undefined) {
		const rows = (await conn.query("SELECT value FROM sync_state WHERE user_id = ? AND key_name = ?", [
			userId,
			key,
		])) as Array<{ value: string }>;
		return rows[0]?.value ?? null;
	}
	const row = await db()
		.selectFrom("sync_state")
		.select("value")
		.where("user_id", "=", userId)
		.where("key_name", "=", key)
		.executeTakeFirst();
	return row?.value ?? null;
}

export async function setSyncState(
	userId: string,
	key: string,
	value: string,
	conn?: mariadb.Connection,
): Promise<void> {
	if (conn !== undefined) {
		await conn.query(
			`INSERT INTO sync_state (user_id, key_name, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
			[userId, key, value],
		);
		return;
	}
	await db()
		.insertInto("sync_state")
		.values({ user_id: userId, key_name: key, value })
		.onDuplicateKeyUpdate({ value })
		.execute();
}
