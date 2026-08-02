/** The one boundary that turns a caught value into a sentence.
 *
 * `catch` and rxjs hand you `unknown`, and `String(err)` on anything that is not
 * an `Error` renders `"[object Object]"` — which is then what the log line or
 * the screen says instead of the reason. That failure mode is invisible until
 * the day the thrown thing stops being an `Error`, and by then the diagnostic
 * that would have explained it is gone.
 *
 * Every catch site in this codebase routes through here, so there is one place
 * that decides what a caught value reads as (DL-ANGULAR-ERROR-STRINGIFIED).
 * The order matters:
 *
 *   - an `Error` reads as its message — the common case, unchanged;
 *   - a string throws as itself;
 *   - anything else is JSON, so an `HttpErrorResponse`-shaped object or a
 *     `{ code, errno }` from the driver still says something. `JSON.stringify`
 *     returns `undefined` for a function or a bare `undefined`, and throws on a
 *     cycle, so both fall back to `Object.prototype.toString`, which at least
 *     names the type.
 */
export function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err) ?? Object.prototype.toString.call(err);
	} catch {
		return Object.prototype.toString.call(err);
	}
}
