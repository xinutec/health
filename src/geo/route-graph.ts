/**
 * Route graph: OSM ways + nodes as a queryable graph data structure.
 *
 * Phase 0 of the route-aware decoder proposal
 * (`docs/design/probabilistic-principles.md`). This module is
 * the foundation that Phase 1 (route-aware train states) builds on.
 *
 * The graph turns the raw `osm_lines` + `osm_points` tables into:
 *
 *   - Edges (osm_lines rows) with derived attributes:
 *       `underground` (tunnel/layer/subway), `lineMemberships`
 *       (composite-name-aware), `lengthM` (haversine).
 *   - Nodes at way endpoints. Two ways that share an endpoint share
 *     a node — that's the topological connectivity the route-aware
 *     decoder uses for transitions.
 *   - Optional station/junction metadata attached to nodes when an
 *     `osm_points` row with railway=station / public_transport tags
 *     coincides with a way endpoint.
 *   - A spatial query (`edgesNear`) for mapping a GPS fix to nearby
 *     edges.
 *
 * Pure module: takes already-loaded rows, returns the graph. DB
 * loading lives in the caller. Stateless and deterministic.
 */

const M_PER_DEG_LAT = 111_320;

/** Raw osm_lines row shape — matches `OsmLinesTable` in `src/db/tables.ts`. */
export interface RawOsmLine {
	osm_id: bigint;
	osm_type: string;
	feature_type: string;
	subtype: string | null;
	name: string | null;
	tags_json: string | null;
	geom: string; // WKT LINESTRING
}

/** Raw osm_points row shape — name/tags + lat/lon. */
export interface RawOsmPoint {
	osm_id: bigint;
	osm_type: string;
	name: string | null;
	tags_json: string | null;
	lat: number;
	lon: number;
}

export interface RouteEdgeAttrs {
	featureType: string;
	subtype: string | null;
	name: string | null;
	/** True when the way is underground — derived from `tunnel=yes`,
	 *  `layer<0`, `covered=yes`, or `subtype=subway` on a railway. */
	underground: boolean;
	/** Set of rail line names this way belongs to. Handles OSM's
	 *  composite tagging convention ("Circle, Hammersmith & City and
	 *  Metropolitan Lines" → three line names). Empty for non-rail
	 *  features. */
	lineMemberships: ReadonlySet<string>;
	/** Length in metres computed from haversine over geometry points. */
	lengthM: number;
}

export interface RouteEdge {
	/** Composite identifier `${osm_type}:${osm_id}` — stable string
	 *  key. */
	id: string;
	/** Ordered geometry, lat/lon pairs. First and last are the
	 *  endpoints. */
	geometry: readonly { lat: number; lon: number }[];
	startPoint: { lat: number; lon: number };
	endPoint: { lat: number; lon: number };
	attrs: RouteEdgeAttrs;
}

export interface RouteNode {
	/** Stable identifier — endpoint coords rounded to ~1m precision. */
	id: string;
	point: { lat: number; lon: number };
	/** Edge IDs incident to this node (shared endpoint). */
	edgeIds: ReadonlySet<string>;
	/** Station name from an OSM point that coincides with this node. */
	stationName?: string;
	/** Line memberships of the station (parsed from its `network` /
	 *  `route_ref` tags or its name). */
	stationLineMemberships?: ReadonlySet<string>;
}

export interface RouteGraph {
	edges: ReadonlyMap<string, RouteEdge>;
	nodes: ReadonlyMap<string, RouteNode>;
	/** Spatial query: edges whose geometry passes within `radiusM`
	 *  of `(lat, lon)`. Uses an internal grid index for O(1)
	 *  candidate generation. */
	edgesNear(lat: number, lon: number, radiusM: number): RouteEdge[];
}

/** Round a coordinate to ~1m precision for stable node-id derivation.
 *  5 decimal places of latitude ≈ 1.1m on the surface; longitude is
 *  similar at London latitude. */
export function nodeKey(lat: number, lon: number): string {
	return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Parse a WKT LINESTRING into an ordered lat/lon array. WKT is
 *  `lon lat` per the convention; we flip to lat/lon. Returns empty
 *  on malformed input. */
function parseLineStringWkt(wkt: string): { lat: number; lon: number }[] {
	const m = /^LINESTRING\s*\(\s*(.+?)\s*\)\s*$/i.exec(wkt);
	if (!m) return [];
	const pairs = m[1].split(",");
	const out: { lat: number; lon: number }[] = [];
	for (const pair of pairs) {
		const parts = pair.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const lon = Number(parts[0]);
		const lat = Number(parts[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		out.push({ lat, lon });
	}
	return out;
}

/** Parse OSM tags_json safely. Returns an empty object on null /
 *  malformed input. */
function parseTags(tagsJson: string | Record<string, string> | null): Record<string, string> {
	if (tagsJson === null) return {};
	// MariaDB JSON columns sometimes come back already parsed; the
	// capture-fixture round-trip writes them as objects. Accept both.
	if (typeof tagsJson === "object") return tagsJson as Record<string, string>;
	try {
		const parsed = JSON.parse(tagsJson);
		if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
	} catch {
		// fall through
	}
	return {};
}

/** Detect underground status from OSM tags + subtype. Soft union of
 *  the conventions OSM uses to mean "below surface":
 *  - `tunnel=yes` (or any non-"no" tunnel value)
 *  - `layer < 0`
 *  - `covered=yes` (less precise but generally underground)
 *  - `subway=yes`
 *  - subtype = "subway" (London Underground rail explicitly tagged) */
function isUnderground(tags: Record<string, string>, subtype: string | null): boolean {
	if (tags.tunnel !== undefined && tags.tunnel !== "no") return true;
	if (tags.layer !== undefined) {
		const n = Number(tags.layer);
		if (Number.isFinite(n) && n < 0) return true;
	}
	if (tags.covered === "yes") return true;
	if (tags.subway === "yes") return true;
	if (subtype === "subway") return true;
	return false;
}

/** Parse a way's `name` field into the set of rail line names it
 *  belongs to. Handles OSM's composite tagging where multiple lines
 *  that share track are merged into a single name string.
 *
 *  Strategy:
 *    1. Strip a trailing " Line" or " Lines" suffix.
 *    2. Split the remaining on " and " (the conjunction that
 *       separates the last line from the rest).
 *    3. Each part: split on ", " (commas separating earlier lines).
 *    4. Add " Line" back to each part.
 *
 *  Examples handled correctly:
 *    "Metropolitan Line" → {"Metropolitan Line"}
 *    "Hammersmith & City Line" → {"Hammersmith & City Line"}
 *      (no " and " or "," — '&' is preserved as part of the name)
 *    "Circle, Hammersmith & City and Metropolitan Lines"
 *      → {"Circle Line", "Hammersmith & City Line", "Metropolitan Line"}
 *    "Metropolitan and Piccadilly Line"
 *      → {"Metropolitan Line", "Piccadilly Line"}
 *
 *  Returns an empty set for names that don't end in "Line"/"Lines".  */
export function parseLineMemberships(name: string | null): Set<string> {
	if (name === null || name === "") return new Set();
	// Strip trailing directionals before line/lines pruning. OSM tags
	// many physical-track ways as "Jubilee Line Eastbound" or
	// "Metropolitan Line Westbound" to distinguish the two parallel
	// tracks. The line membership is the same either way.
	let cleaned = name.trim();
	const DIRECTIONALS = [" Eastbound", " Westbound", " Northbound", " Southbound", " Inner Rail", " Outer Rail"];
	let stripped: string | null = null;
	for (const dir of DIRECTIONALS) {
		if (cleaned.endsWith(dir)) {
			cleaned = cleaned.slice(0, -dir.length).trim();
			break;
		}
	}
	if (cleaned.endsWith(" Lines")) {
		stripped = cleaned.slice(0, -" Lines".length);
	} else if (cleaned.endsWith(" Line")) {
		stripped = cleaned.slice(0, -" Line".length);
	} else {
		return new Set();
	}
	const out = new Set<string>();
	for (const andPart of stripped.split(" and ")) {
		for (const commaPart of andPart.split(", ")) {
			const trimmed = commaPart.trim();
			if (trimmed.length > 0) out.add(`${trimmed} Line`);
		}
	}
	return out;
}

function geometryLengthM(geom: readonly { lat: number; lon: number }[]): number {
	let total = 0;
	for (let i = 1; i < geom.length; i++) {
		total += haversineMeters(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
	}
	return total;
}

/** Approximate distance from a point to a polyline. For each segment
 *  of the polyline, compute the perpendicular distance from the
 *  point to the segment (clamped at endpoints). Return the minimum
 *  across segments. */
export function pointToPolylineMeters(
	lat: number,
	lon: number,
	geometry: readonly { lat: number; lon: number }[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 1; i < geometry.length; i++) {
		const d = pointToSegmentMeters(lat, lon, geometry[i - 1], geometry[i]);
		if (d < best) best = d;
	}
	return best;
}

function pointToSegmentMeters(
	lat: number,
	lon: number,
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	// Project to local-flat-Earth Cartesian — coords as scaled
	// degrees in metres. Accurate enough at sub-km scales.
	const cosRefLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const pX = (lon - a.lon) * M_PER_DEG_LAT * cosRefLat;
	const pY = (lat - a.lat) * M_PER_DEG_LAT;
	const dX = (b.lon - a.lon) * M_PER_DEG_LAT * cosRefLat;
	const dY = (b.lat - a.lat) * M_PER_DEG_LAT;
	const len2 = dX * dX + dY * dY;
	if (len2 === 0) return Math.hypot(pX, pY);
	const t = Math.max(0, Math.min(1, (pX * dX + pY * dY) / len2));
	const projX = t * dX;
	const projY = t * dY;
	return Math.hypot(pX - projX, pY - projY);
}

/** Build a spatial index: a grid bucketing every edge into every
 *  cell it touches, so `edgesNear` can scan only the local cells
 *  rather than all edges.
 *
 *  Cell size ~500 m: 0.0045° latitude, ~0.007° longitude at London.
 *  Each edge inserts into the cells of every (cell-containing)
 *  geometry point — coarse but cheap.  */
const GRID_CELL_DEG_LAT = 0.0045;
const GRID_CELL_DEG_LON = 0.007;

function cellKey(lat: number, lon: number): string {
	const cy = Math.floor(lat / GRID_CELL_DEG_LAT);
	const cx = Math.floor(lon / GRID_CELL_DEG_LON);
	return `${cy}:${cx}`;
}

function neighborCellKeys(lat: number, lon: number): string[] {
	const cy = Math.floor(lat / GRID_CELL_DEG_LAT);
	const cx = Math.floor(lon / GRID_CELL_DEG_LON);
	const out: string[] = [];
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			out.push(`${cy + dy}:${cx + dx}`);
		}
	}
	return out;
}

export function buildRouteGraph(rawLines: readonly RawOsmLine[], rawPoints: readonly RawOsmPoint[]): RouteGraph {
	const edges = new Map<string, RouteEdge>();
	const nodes = new Map<string, RouteNode>();
	const nodeEdgeIndex = new Map<string, Set<string>>();
	const cellIndex = new Map<string, Set<string>>();

	for (const r of rawLines) {
		const geometry = parseLineStringWkt(r.geom);
		if (geometry.length < 2) continue;
		const tags = parseTags(r.tags_json);
		const id = `${r.osm_type}:${r.osm_id.toString()}`;
		const edge: RouteEdge = {
			id,
			geometry,
			startPoint: geometry[0],
			endPoint: geometry[geometry.length - 1],
			attrs: {
				featureType: r.feature_type,
				subtype: r.subtype,
				name: r.name,
				underground: isUnderground(tags, r.subtype),
				lineMemberships: parseLineMemberships(r.name),
				lengthM: geometryLengthM(geometry),
			},
		};
		edges.set(id, edge);

		// Endpoint nodes.
		for (const p of [edge.startPoint, edge.endPoint]) {
			const key = nodeKey(p.lat, p.lon);
			let set = nodeEdgeIndex.get(key);
			if (set === undefined) {
				set = new Set();
				nodeEdgeIndex.set(key, set);
			}
			set.add(id);
		}

		// Insert into spatial grid: every cell touched by any geometry
		// vertex gets this edge as a candidate. Coarse but cheap and
		// correct.
		const cells = new Set<string>();
		for (const p of geometry) cells.add(cellKey(p.lat, p.lon));
		for (const c of cells) {
			let bucket = cellIndex.get(c);
			if (bucket === undefined) {
				bucket = new Set();
				cellIndex.set(c, bucket);
			}
			bucket.add(id);
		}
	}

	// Materialise nodes from the edge-index.
	for (const [key, edgeIds] of nodeEdgeIndex) {
		const [latStr, lonStr] = key.split(",");
		const lat = Number(latStr);
		const lon = Number(lonStr);
		nodes.set(key, { id: key, point: { lat, lon }, edgeIds });
	}

	// Annotate nodes with station metadata when an osm_points row
	// coincides within ~150 m of a node. Tube station POIs in OSM
	// are tagged at the street entrance, which can sit 50–150 m
	// from the platform-aligned way endpoint of the underground
	// rail (the station hall, escalators, and ticket gates are
	// typically that far above the platform).
	//
	// 150 m is the upper-end "yes this POI is this station node"
	// hard cutoff — at this distance every London Tube station POI
	// gets attached to a way endpoint. The candidate generator
	// applies a wider GENEROUS hard cutoff (250 m) downstream and
	// lets the scorer weigh distance softly. See
	// `docs/proposals/decoder-roadmap.md` on
	// generator/scorer radii.
	const STATION_MERGE_RADIUS_M = 150;
	for (const p of rawPoints) {
		const tags = parseTags(p.tags_json);
		const isStation =
			tags.railway === "station" ||
			tags.railway === "stop" ||
			tags.railway === "halt" ||
			tags.public_transport === "station" ||
			tags.public_transport === "stop_position" ||
			tags.subway === "yes" ||
			tags.amenity === "tram_stop" ||
			tags.highway === "bus_stop";
		if (!isStation) continue;
		// Find a node within radius. Iterate the cell + neighbors.
		let bestKey: string | null = null;
		let bestDist = Number.POSITIVE_INFINITY;
		for (const c of neighborCellKeys(p.lat, p.lon)) {
			const bucket = cellIndex.get(c);
			if (bucket === undefined) continue;
			for (const edgeId of bucket) {
				const edge = edges.get(edgeId);
				if (edge === undefined) continue;
				for (const endpoint of [edge.startPoint, edge.endPoint]) {
					const d = haversineMeters(p.lat, p.lon, endpoint.lat, endpoint.lon);
					if (d < bestDist && d <= STATION_MERGE_RADIUS_M) {
						bestDist = d;
						bestKey = nodeKey(endpoint.lat, endpoint.lon);
					}
				}
			}
		}
		if (bestKey === null) continue;
		const node = nodes.get(bestKey);
		if (node === undefined) continue;
		const memberships = parseLineMemberships(tags.route_name ?? p.name);
		// Replace by an annotated copy (Map doesn't carry attribute
		// changes through references).
		nodes.set(bestKey, {
			...node,
			stationName: p.name ?? undefined,
			stationLineMemberships: memberships.size > 0 ? memberships : undefined,
		});
	}

	function edgesNear(lat: number, lon: number, radiusM: number): RouteEdge[] {
		const out: RouteEdge[] = [];
		const seen = new Set<string>();
		for (const c of neighborCellKeys(lat, lon)) {
			const bucket = cellIndex.get(c);
			if (bucket === undefined) continue;
			for (const edgeId of bucket) {
				if (seen.has(edgeId)) continue;
				seen.add(edgeId);
				const edge = edges.get(edgeId);
				if (edge === undefined) continue;
				const d = pointToPolylineMeters(lat, lon, edge.geometry);
				if (d <= radiusM) out.push(edge);
			}
		}
		return out;
	}

	return { edges, nodes, edgesNear };
}
