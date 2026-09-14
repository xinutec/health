/**
 * Whether the map container is big enough for `fitBounds` to compute a real
 * zoom — the one decision that stands between a normal map and a wedged
 * renderer (#1616).
 *
 * Split out of `map.component.ts` for the same reason as `map.labels.ts`: the
 * rule with an actual decision in it should be testable without standing up
 * Leaflet.
 */

/** The padding passed to `fitBounds`, in CSS pixels per side. */
export const FIT_PADDING_PX = 24;

/**
 * Can `fitBounds` fit a track into a container of this size?
 *
 * ⚠ **A `false` HERE PREVENTS A NaN ZOOM, WHICH HANGS THE RENDERER.**
 * `fitBounds(b, {padding:[p,p]})` calls `getBoundsZoom(b, false, TL.add(BR))`,
 * i.e. with `2p`, and that does:
 *
 * ```text
 * size  = getSize().subtract(padding)     // 0x0 container -> (-2p, -2p)
 * scale = Math.min(size.x / bx, size.y / by)   // NEGATIVE
 * zoom  = getScaleZoom(scale, zoom)            // log2(negative) -> NaN
 * return Math.max(min, Math.min(max, zoom))    // NaN SURVIVES BOTH CLAMPS
 * ```
 *
 * Leaflet then guards `if (zoom === Infinity)` — it anticipated EMPTY BOUNDS
 * and not a negative size — so NaN reaches `project()` and `setView()`, and the
 * tile grid is computed from NaN. Measured on a Pixel 9 2026-09-14: the
 * renderer spun at ~88% of a core and never serviced JavaScript again, so the
 * map was blank and every button in the app was dead.
 *
 * ⚠ **STRICTLY GREATER, NOT `>=`.** At exactly `2p` the subtraction gives 0,
 * `scale` is 0, and `log2(0)` is `-Infinity` — not NaN, but not a zoom either.
 *
 * ⚠ **BOTH AXES.** A container can be full-width and zero-height mid-transition;
 * `Math.min` takes the worse of the two, so one bad axis is enough.
 */
export function canFitBounds(
	size: { x: number; y: number },
	paddingPx: number = FIT_PADDING_PX,
): boolean {
	const consumed = paddingPx * 2;
	return size.x > consumed && size.y > consumed;
}
