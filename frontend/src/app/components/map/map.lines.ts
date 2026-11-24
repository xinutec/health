/**
 * An episode's line as runs of one stroke each.
 *
 * A point's `inferred` says the edge arriving at it is backed by neither a
 * mapped path nor a sharp GPS fix (`Verified.Geo.WalkBacked`): the map draws
 * that edge dashed. Consecutive edges of one stroke share a polyline, and a
 * run starts at the point the previous one ended on, so the line is unbroken.
 */

export interface LinePoint {
	lat: number;
	lon: number;
	inferred?: boolean;
}

export interface LineRun {
	coords: [number, number][];
	dashed: boolean;
}

/** `allDashed`: the whole episode is inferred geometry (a snapped rail line, a
 *  gap connector), whatever its points say. */
export function lineRuns(points: readonly LinePoint[], allDashed: boolean): LineRun[] {
	const runs: LineRun[] = [];
	for (let i = 1; i < points.length; i++) {
		const dashed = allDashed || points[i].inferred === true;
		const to: [number, number] = [points[i].lat, points[i].lon];
		const last = runs.at(-1);
		if (last?.dashed === dashed) {
			last.coords.push(to);
		} else {
			runs.push({ coords: [[points[i - 1].lat, points[i - 1].lon], to], dashed });
		}
	}
	return runs;
}
