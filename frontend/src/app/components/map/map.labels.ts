/**
 * What a drawn point's `kind` means as a data source — the answer the
 * tap-to-inspect popup gives to "where does this point come from".
 *
 * Split out of `map.component.ts` so the one rule with an actual decision in it
 * (see `sourceLabel`) is testable without standing up Leaflet, following the
 * `.logic.ts` split the pull-to-refresh and battery-chart components use.
 */

import type { EpisodeGeometry } from "../../services/health.service";

export type PointKind = EpisodeGeometry["kind"] | "live";

/** Keyed on the episode kinds plus `live` (the latest-fix marker, which the map
 *  draws itself and which has no backend episode). `Record<…>` rather than
 *  `Record<string, …>` so a new kind is a build error here instead of a popup
 *  that shows the raw slug — the kinds themselves are held to the backend union
 *  by scripts/check-frontend-unions.mjs (#337). */
export const SOURCE_LABEL: Record<PointKind, string> = {
	raw: "raw GPS fix",
	matched: "map-matched to road/path",
	snapped: "snapped to rail line",
	smoothed: "smoothed GPS (denoised)",
	anchor: "stay centre (computed average)",
	tentative: "gap connector (inferred, no GPS)",
	live: "live position (latest fix)",
};

/**
 * `raw` is the one kind whose provenance is not decided by the kind alone.
 *
 * An unmatched MOVING leg draws `displayFixes` — the cleaned PhoneTrack track,
 * pre-Kalman and un-snapped — so "raw GPS fix" is literally true there. A train
 * leg with no cached route draws the Kalman-FILTERED points instead (the
 * uncached-overground branch of `episode-geometry.ts`), and calling those raw
 * overstates them: the filter can sit tens of metres off the fix it came from,
 * which is what made a fix Nextcloud drew at 51.566181,-0.278725 appear at
 * 51.566050,-0.279866 here — 80 m away (#266).
 *
 * The backend cannot currently be asked which it was, since both branches ship
 * `kind: "raw"`, so the mode is what separates them — and it only separates the
 * systematic case. A moving leg with fewer than two raw fixes in its window
 * falls back to the filtered points too and still reads as raw here; telling
 * that one apart needs the provenance on the wire.
 */
export function sourceLabel(kind: PointKind, mode: string): string {
	if (kind === "raw" && mode === "train") return "GPS fix (Kalman-filtered)";
	return SOURCE_LABEL[kind] ?? kind;
}
