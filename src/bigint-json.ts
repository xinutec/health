/**
 * Make BigInt JSON-serialisable globally.
 *
 * `JSON.stringify` throws on BigInt by default ("Do not know how to
 * serialize a BigInt"). The DB now returns 64-bit IDs as native
 * BigInt (so we don't round large Fitbit sleep log IDs), but Hono's
 * `c.json(...)` and any other JSON.stringify users would crash.
 *
 * The de-facto fix is to patch `BigInt.prototype.toJSON` to return a
 * string. JSON.stringify checks toJSON before falling back to its
 * default handlers, so this turns BigInt fields into JSON strings on
 * the wire (`"7159200472543411371"`). Frontends that compare IDs as
 * strings work transparently; consumers that need arithmetic call
 * BigInt() on their end.
 *
 * Import this module once from each process entry point (server.ts,
 * sync.ts, any CLI). The side-effect is idempotent.
 */

// Cast through unknown so TS lets us add to the BigInt prototype.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint): string {
	return this.toString();
};
