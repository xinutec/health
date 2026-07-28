/**
 * Reading values that came from outside the app — a `catch` binding, a
 * `fetch` body, `localStorage` — without asserting what they are.
 *
 * `x as Shape` is a claim, not a check: it tells the compiler what arrived and
 * then never looks. When the claim is wrong the failure surfaces far from the
 * line that made it — as `undefined` where the types promised a value, or as
 * "[object Object]" on screen where they promised a string. Nothing in the
 * toolchain can catch that, because the assertion is the thing that lied to it.
 */

/** A value that can be indexed by string — i.e. worth asking about a field. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The named field, only if it really is a non-empty string. */
export function stringField(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const field = value[key];
	return typeof field === "string" && field !== "" ? field : null;
}

/** The named field, only if it really is a number. */
export function numberField(value: unknown, key: string): number | null {
	if (!isRecord(value)) return null;
	const field = value[key];
	return typeof field === "number" ? field : null;
}

/**
 * What to show the user about a failure.
 *
 * `catch (e)` binds `unknown`, and `(e as Error).message` was the shorthand for
 * "it'll be an Error". Usually it is — but a rejected `fetch` promise, a thrown
 * string, or a rejected non-Error all land here too, and then `.message` is
 * `undefined` and the banner renders empty: the app says something went wrong
 * and refuses to say what. Anything without a real message gets a sentence
 * rather than a blank.
 */
export function errorText(error: unknown, fallback = "Something went wrong"): string {
	if (error instanceof Error && error.message !== "") return error.message;
	const message = stringField(error, "message");
	if (message !== null) return message;
	return typeof error === "string" && error !== "" ? error : fallback;
}
