/**
 * Pure pull-to-refresh maths, split from the component so the bits that can be
 * *wrong* (the rubber-band curve, the trigger threshold, the spinner progress)
 * are unit-tested without a DOM or touch events.
 */

/** Pull past this many on-screen pixels to trigger a refresh on release. */
export const PTR_THRESHOLD_PX = 70;
/** Hard cap on the visible pull distance (rubber-band limit). */
export const PTR_MAX_PULL_PX = 110;
/** Resting height the indicator holds at while the reload runs. */
export const PTR_REST_PX = 48;
/** Minimum spinner-visible time so a cache-fast reload still reads as "did something". */
export const PTR_MIN_SPIN_MS = 500;
/** Finger travel → pull distance before the cap (a gentle rubber-band). */
const RESISTANCE = 0.5;

/** A touch that starts inside an element matching this selector belongs to that
 *  element's own drag gesture (e.g. panning the Leaflet map), not a
 *  pull-to-refresh — so the gesture is not armed there. Any other element can
 *  opt out the same way with a `data-no-pull-refresh` attribute. */
export const PTR_EXCLUDE_SELECTOR = ".leaflet-container, [data-no-pull-refresh]";

/**
 * Visible pull distance for a raw downward finger delta, with rubber-band
 * resistance and a hard cap. A non-positive delta (finger moving up, or not
 * yet moved) yields 0 — there is nothing to reveal.
 */
export function pullDistance(dyPx: number, maxPull = PTR_MAX_PULL_PX, resistance = RESISTANCE): number {
	if (dyPx <= 0) return 0;
	return Math.min(maxPull, dyPx * resistance);
}

/** Whether the current pull is far enough that releasing triggers a refresh. */
export function isArmed(pullPx: number, threshold = PTR_THRESHOLD_PX): boolean {
	return pullPx >= threshold;
}

/** Indicator progress 0..1 as the pull approaches the threshold (drives the
 *  arrow's opacity before it's armed). Clamped to [0, 1]. */
export function pullProgress(pullPx: number, threshold = PTR_THRESHOLD_PX): number {
	return Math.max(0, Math.min(1, pullPx / threshold));
}
