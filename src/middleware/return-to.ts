/**
 * Validate an optional `return_to` redirect target supplied by the
 * client to an OAuth flow.
 *
 * The danger this guards against is the classic open-redirect: an
 * attacker emails the user a link like
 * `https://health.xinutec.org/login?return_to=//evil.com`. The user
 * clicks it, authenticates normally, and the callback issues
 * `302 Location: //evil.com` — a protocol-relative URL the browser
 * follows off-site. Useful for phishing or for siphoning any state
 * exposed in the redirect chain.
 *
 * The accepted shape is intentionally narrow:
 *
 *   - Must start with a single `/` followed by a non-`/` character.
 *     `//evil.com` and `/\evil.com` (some browsers normalise `\` to
 *     `/`) both get rejected.
 *   - May contain ASCII alphanumerics, the URL-safe punctuation
 *     `?=&%-._/+`, but no whitespace, control chars, or anything
 *     unusual that could break a renderer or smuggle an injection.
 *   - Anything else falls back to `/`.
 *
 * Returning `/` on any rejection keeps callers branch-free — they can
 * always redirect to the result, whether the input was valid or not.
 */

const SAFE_PATH = /^\/[a-zA-Z0-9_\-.~+/?=&%]*$/;

export function validateReturnTo(raw: string | undefined): string {
	if (!raw) return "/";
	// Single-leading-slash followed by a non-slash. This explicitly
	// rejects `//foo` (protocol-relative) and `/\foo` (backslash trick).
	if (raw === "/") return "/";
	if (raw.length < 2 || raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return "/";
	if (!SAFE_PATH.test(raw)) return "/";
	return raw;
}
