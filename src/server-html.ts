/**
 * HTML escape helper for the server-rendered fallback pages.
 *
 * Replaces the five HTML metacharacters with their entity equivalents.
 * Order matters: `&` is replaced first so a later `<` → `&lt;` does
 * not double-encode into `&amp;lt;`. Single quotes use the numeric
 * `&#39;` form because not every HTML4-era parser knows the named
 * entity `&apos;`.
 *
 * Use this anywhere user-influenced content lands in an HTML template
 * string. The Angular SPA does its own escaping via Angular's binding
 * system; this helper only matters for the small static pages served
 * directly by Hono in `server.ts`.
 */

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
