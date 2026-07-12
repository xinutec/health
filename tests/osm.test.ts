import { describe, expect, it } from "vitest";
import {
	commonCity,
	dedupeStationsByName,
	extractCity,
	extractLineNames,
	filterLandmarks,
	isEnclosingInstitution,
	isLabelWorthyVenue,
	isLodgingLandmark,
	landmarkToResult,
	type NearbyLandmark,
	type NearbyStation,
	type NearbyWay,
	type NominatimResult,
	pickBestLandmark,
	pickBestStation,
	pickLodgingOverride,
	placeLabel,
	refineMode,
} from "../src/geo/osm.js";

describe("commonCity", () => {
	const r = (city?: string, town?: string): NominatimResult => ({
		displayName: "x",
		type: "y",
		category: "z",
		address: { ...(city && { city }), ...(town && { town }) },
	});

	it("returns the shared city when both endpoints agree", () => {
		expect(commonCity(r("City A"), r("City A"))).toBe("City A");
	});

	it("returns null when the endpoints disagree", () => {
		expect(commonCity(r("City A"), r("City B"))).toBeNull();
	});

	it("returns null when either side has no city", () => {
		expect(commonCity(r(), r("City A"))).toBeNull();
		expect(commonCity(r("City A"), r())).toBeNull();
	});

	it("returns null when either side is null (geocode failed)", () => {
		expect(commonCity(null, r("City A"))).toBeNull();
		expect(commonCity(r("City A"), null)).toBeNull();
		expect(commonCity(null, null)).toBeNull();
	});

	it("uses the same fallback chain as extractCity (town counts)", () => {
		// One endpoint reports as `town`, the other as `city`: same place name → match.
		expect(commonCity(r(undefined, "Town X"), r("Town X"))).toBe("Town X");
	});
});

describe("extractCity", () => {
	const baseResult = {
		displayName: "x",
		type: "y",
		category: "z",
	};

	it("returns the city field when present", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "City A" } };
		expect(extractCity(r)).toBe("City A");
	});

	it("falls back to town when no city is set", () => {
		const r: NominatimResult = { ...baseResult, address: { town: "Town X" } };
		expect(extractCity(r)).toBe("Town X");
	});

	it("falls back to village when no city or town is set", () => {
		const r: NominatimResult = { ...baseResult, address: { village: "Village V" } };
		expect(extractCity(r)).toBe("Village V");
	});

	it("falls back to municipality when no city/town/village", () => {
		const r: NominatimResult = { ...baseResult, address: { municipality: "Municipality M" } };
		expect(extractCity(r)).toBe("Municipality M");
	});

	it("prefers city over town when both are set", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "City A", town: "Town X" } };
		expect(extractCity(r)).toBe("City A");
	});

	it("returns null for an empty address", () => {
		const r: NominatimResult = { ...baseResult, address: {} };
		expect(extractCity(r)).toBeNull();
	});

	it("returns null for a null result", () => {
		expect(extractCity(null)).toBeNull();
	});

	// Coarse grouping for metropolitan areas. Nominatim returns admin
	// boundaries at multiple levels; for cities that are administratively
	// subdivided (London boroughs, Paris arrondissements) the per-fix
	// `city` field is the subdivision, not the metro area. That made the
	// timeline UI break a single London day into "Greater London → City of
	// Westminster → Greater London" headers.
	it("prefers state_district when it's a recognised metropolitan area", () => {
		const r: NominatimResult = {
			...baseResult,
			address: { city: "City of Westminster", state_district: "Greater London" },
		};
		expect(extractCity(r)).toBe("Greater London");
	});

	it("uses state_district even when city is City of London", () => {
		const r: NominatimResult = {
			...baseResult,
			address: { city: "City of London", state_district: "Greater London" },
		};
		expect(extractCity(r)).toBe("Greater London");
	});

	it("falls back to city when state_district is not a recognised metro", () => {
		// Most cities don't have a metro-area state_district. "City C"
		// is in "Province P" — a province, not a metropolitan area —
		// so we should NOT promote it.
		const r: NominatimResult = {
			...baseResult,
			address: { city: "City C", state_district: "Province P" },
		};
		expect(extractCity(r)).toBe("City C");
	});

	it("falls back to city when state_district is absent", () => {
		// Most older / non-UK responses won't carry state_district.
		// Backward compat: behaves like before.
		const r: NominatimResult = { ...baseResult, address: { city: "City A" } };
		expect(extractCity(r)).toBe("City A");
	});

	it("collapses 'City of Westminster' to 'Greater London'", () => {
		// Westminster is administratively its own city in Nominatim's
		// model, so it appears as city='City of Westminster' with no
		// state_district or borough to override. Most London boroughs
		// return city='Greater London' directly; only the two 'City of'
		// subdivisions need explicit mapping.
		const r: NominatimResult = { ...baseResult, address: { city: "City of Westminster" } };
		expect(extractCity(r)).toBe("Greater London");
	});

	it("collapses 'City of London' to 'Greater London'", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "City of London" } };
		expect(extractCity(r)).toBe("Greater London");
	});
});

describe("placeLabel", () => {
	it("uses amenity name when available", () => {
		const r: NominatimResult = {
			displayName: "Restaurant R, City A, Country",
			type: "restaurant",
			category: "amenity",
			address: { amenity: "Restaurant R", city: "City A" },
		};
		expect(placeLabel(r)).toBe("Restaurant R (restaurant)");
	});

	it("uses building name + type when no amenity", () => {
		const r: NominatimResult = {
			displayName: "Some Office, Street, City",
			type: "office",
			category: "building",
			address: { building: "Some Office", road: "Street" },
		};
		expect(placeLabel(r)).toBe("Some Office (office)");
	});

	it("uses type + road when no amenity or building name", () => {
		const r: NominatimResult = {
			displayName: "Park, Some Road, City",
			type: "park",
			category: "leisure",
			address: { road: "Some Road" },
		};
		expect(placeLabel(r)).toBe("park on Some Road");
	});

	it("falls back to first part of display name", () => {
		const r: NominatimResult = {
			displayName: "Unknown Place, Somewhere",
			type: "",
			category: "",
			address: {},
		};
		expect(placeLabel(r)).toBe("Unknown Place");
	});

	it("uses tourism name when present (hotel, museum)", () => {
		const r: NominatimResult = {
			displayName: "Hotel H, Place A, City C",
			type: "hotel",
			category: "tourism",
			address: { tourism: "Hotel H", road: "Place A" },
		};
		expect(placeLabel(r)).toBe("Hotel H (hotel)");
	});

	it("uses leisure name when present (park, playground)", () => {
		const r: NominatimResult = {
			displayName: "Park P, City A",
			type: "park",
			category: "leisure",
			address: { leisure: "Park P" },
		};
		expect(placeLabel(r)).toBe("Park P (park)");
	});

	it("uses shop name when present", () => {
		const r: NominatimResult = {
			displayName: "Grocery G, Street S",
			type: "supermarket",
			category: "shop",
			address: { shop: "Grocery G", road: "Street S" },
		};
		expect(placeLabel(r)).toBe("Grocery G (supermarket)");
	});

	it("uses house_number + road for a residential address", () => {
		const r: NominatimResult = {
			displayName: "161, Place A, District D, City C, XX",
			type: "house",
			category: "place",
			address: { house_number: "161", road: "Place A", suburb: "District D" },
		};
		expect(placeLabel(r)).toBe("Place A 161");
	});

	it("uses pedestrian (square / pedestrian street) name", () => {
		// Zoom-16 lookups commonly land on named squares like Place A
		const r: NominatimResult = {
			displayName: "Place A, District D, City C",
			type: "square",
			category: "place",
			address: { pedestrian: "Place A", neighbourhood: "District D" },
		};
		expect(placeLabel(r)).toBe("Place A (square)");
	});
});

describe("pickBestLandmark", () => {
	it("prefers amenity over place at the same distance", () => {
		const landmarks: NearbyLandmark[] = [
			{ name: "Place A", type: "place", subtype: "square", distanceM: 50 },
			{ name: "Restaurant R", type: "amenity", subtype: "restaurant", distanceM: 50 },
		];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Restaurant R");
	});

	it("falls back to closest among same priority", () => {
		const landmarks: NearbyLandmark[] = [
			{ name: "Far Cafe", type: "amenity", subtype: "cafe", distanceM: 90 },
			{ name: "Near Restaurant", type: "amenity", subtype: "restaurant", distanceM: 20 },
		];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Near Restaurant");
	});

	it("picks the named pedestrian square when nothing else available", () => {
		const landmarks: NearbyLandmark[] = [{ name: "Place A", type: "highway", subtype: "pedestrian", distanceM: 80 }];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Place A");
	});

	it("prefers an enclosing institution over a closer point amenity", () => {
		// A long dwell inside a hospital: the hospital footprint encloses
		// the GPS centroid, but a small venue's point sits nearer the
		// centroid. The enclosing institution must win — you are in the
		// hospital, not at the cafe whose node happens to be closer.
		const landmarks: NearbyLandmark[] = [
			{ name: "Corner Cafe", type: "amenity", subtype: "cafe", distanceM: 8 },
			{ name: "City Hospital", type: "amenity", subtype: "hospital", distanceM: 55, enclosing: true },
		];
		expect(pickBestLandmark(landmarks).name).toBe("City Hospital");
	});

	it("does not prefer the institution when it does not enclose the stay", () => {
		// Same hospital, but the centroid is outside its footprint — the
		// nearer venue is the right call. Guards against "hospital always
		// wins" regardless of where the stay actually was.
		const landmarks: NearbyLandmark[] = [
			{ name: "Corner Cafe", type: "amenity", subtype: "cafe", distanceM: 8 },
			{ name: "City Hospital", type: "amenity", subtype: "hospital", distanceM: 55 },
		];
		expect(pickBestLandmark(landmarks).name).toBe("Corner Cafe");
	});

	it("falls through to distance when two institutions both enclose", () => {
		const landmarks: NearbyLandmark[] = [
			{ name: "Far Hospital", type: "amenity", subtype: "hospital", distanceM: 90, enclosing: true },
			{ name: "Near University", type: "amenity", subtype: "university", distanceM: 20, enclosing: true },
		];
		expect(pickBestLandmark(landmarks).name).toBe("Near University");
	});

	it("does not let a far higher-priority venue out-rank a much closer one", () => {
		// The motivating bug: a café (amenity) ~95 m off vs a park
		// (leisure) the stay is actually sitting in, 5 m away. Type
		// priority must not override a distance gap that large.
		const landmarks: NearbyLandmark[] = [
			{ name: "Distant Cafe", type: "amenity", subtype: "cafe", distanceM: 95 },
			{ name: "Adjacent Park", type: "leisure", subtype: "park", distanceM: 5 },
		];
		expect(pickBestLandmark(landmarks).name).toBe("Adjacent Park");
	});

	it("still prefers a higher-priority venue when it is only slightly farther", () => {
		// A café 30 m off vs a park 10 m off — the café is a real venue
		// and not dramatically farther, so type priority still wins.
		const landmarks: NearbyLandmark[] = [
			{ name: "Corner Cafe", type: "amenity", subtype: "cafe", distanceM: 30 },
			{ name: "Small Park", type: "leisure", subtype: "park", distanceM: 10 },
		];
		expect(pickBestLandmark(landmarks).name).toBe("Corner Cafe");
	});
});

describe("isEnclosingInstitution", () => {
	it("flags a hospital POINT within the campus radius as enclosing (2026-04-29 HMC Westeinde)", () => {
		// HMC Westeinde is mapped only as a point; the long stop sat ~59 m
		// from it. Without this, the nearest point-POI (a hairdresser 36 m
		// off) wins. The hospital must be treated as enclosing.
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "hospital", distanceM: 59, encloses: false, isPoint: true }),
		).toBe(true);
	});

	it("still flags a polygon-enclosed HOSPITAL even when far (footprint containment)", () => {
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "hospital", distanceM: 200, encloses: true, isPoint: false }),
		).toBe(true);
	});

	it("does NOT flag a hospital point beyond the campus radius", () => {
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "hospital", distanceM: 120, encloses: false, isPoint: true }),
		).toBe(false);
	});

	it("does NOT enclose a university/college — even a polygon that 'contains' it (2026-05-14 LSHTM vs the Greek restaurant)", () => {
		// LSHTM's loose bounding box swallows the restaurant next door
		// (Miné Mané, a mined focus place). University/college are excluded
		// from the enclosing override entirely — only hospitals get it.
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "university", distanceM: 60, encloses: true, isPoint: false }),
		).toBe(false);
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "college", distanceM: 10, encloses: true, isPoint: true }),
		).toBe(false);
	});

	it("does NOT apply the radius fallback to a hospital mapped as a LINE/area (use its encloses signal, not distance)", () => {
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "hospital", distanceM: 60, encloses: false, isPoint: false }),
		).toBe(false);
	});

	it("does NOT apply the radius fallback to a hospital mapped as a LINE/area (use its encloses signal, not distance)", () => {
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "hospital", distanceM: 60, encloses: false, isPoint: false }),
		).toBe(false);
	});

	it("does NOT flag a non-institution amenity, however close (a café is not a campus)", () => {
		expect(
			isEnclosingInstitution({ type: "amenity", subtype: "cafe", distanceM: 5, encloses: false, isPoint: true }),
		).toBe(false);
	});

	it("does NOT flag a non-amenity type (a shop tagged hospital-ish, a leisure ground)", () => {
		expect(
			isEnclosingInstitution({ type: "shop", subtype: "hospital", distanceM: 5, encloses: false, isPoint: true }),
		).toBe(false);
		expect(
			isEnclosingInstitution({ type: "leisure", subtype: "park", distanceM: 5, encloses: true, isPoint: false }),
		).toBe(false);
	});
});

describe("isLabelWorthyVenue", () => {
	it("accepts a close amenity / shop / tourism venue", () => {
		expect(isLabelWorthyVenue({ name: "Cafe", type: "amenity", subtype: "cafe", distanceM: 12 })).toBe(true);
		expect(isLabelWorthyVenue({ name: "Carfaxy", type: "shop", subtype: "bakery", distanceM: 40 })).toBe(true);
		expect(isLabelWorthyVenue({ name: "Museum", type: "tourism", subtype: "museum", distanceM: 8 })).toBe(true);
	});

	it("rejects a leisure type — a park names an area, not a venue the user is at", () => {
		expect(isLabelWorthyVenue({ name: "Park", type: "leisure", subtype: "park", distanceM: 5 })).toBe(false);
	});

	it("rejects a place / highway type", () => {
		expect(isLabelWorthyVenue({ name: "Square", type: "place", subtype: "square", distanceM: 5 })).toBe(false);
		expect(isLabelWorthyVenue({ name: "High St", type: "highway", subtype: "pedestrian", distanceM: 5 })).toBe(false);
	});

	it("rejects a venue the stay is only near, not at", () => {
		// A café 80 m from the stay centroid is something the user passed,
		// not the place they spent the visit. It must not name the cluster.
		expect(isLabelWorthyVenue({ name: "Distant Cafe", type: "amenity", subtype: "cafe", distanceM: 80 })).toBe(false);
	});
});

describe("filterLandmarks", () => {
	it("drops tourism=artwork (POI marker, not a venue)", () => {
		const ls: NearbyLandmark[] = [
			{ name: "Cafe X", type: "amenity", subtype: "cafe", distanceM: 30 },
			{ name: "Artwork A", type: "tourism", subtype: "artwork", distanceM: 19 },
		];
		const out = filterLandmarks(ls);
		expect(out.map((l) => l.name)).toEqual(["Cafe X"]);
	});

	it("drops other POI markers (viewpoint, picnic_site, information)", () => {
		const ls: NearbyLandmark[] = [
			{ name: "View", type: "tourism", subtype: "viewpoint", distanceM: 5 },
			{ name: "Picnic", type: "tourism", subtype: "picnic_site", distanceM: 7 },
			{ name: "Info Board", type: "tourism", subtype: "information", distanceM: 9 },
			{ name: "Hotel H", type: "tourism", subtype: "hotel", distanceM: 50 },
			{ name: "Museum", type: "tourism", subtype: "museum", distanceM: 60 },
		];
		const out = filterLandmarks(ls);
		expect(out.map((l) => l.name)).toEqual(["Hotel H", "Museum"]);
	});

	it("keeps non-tourism types untouched", () => {
		const ls: NearbyLandmark[] = [
			{ name: "Cafe X", type: "amenity", subtype: "cafe", distanceM: 10 },
			{ name: "Park Y", type: "leisure", subtype: "park", distanceM: 20 },
			{ name: "Shop Z", type: "shop", subtype: "supermarket", distanceM: 30 },
			{ name: "Square", type: "place", subtype: "square", distanceM: 40 },
		];
		const out = filterLandmarks(ls);
		expect(out.length).toBe(4);
	});
});

describe("landmarkToResult", () => {
	it("maps amenity into NominatimResult.address.amenity", () => {
		const r = landmarkToResult({ name: "Cafe X", type: "amenity", subtype: "cafe", distanceM: 10 });
		expect(r.address.amenity).toBe("Cafe X");
		expect(placeLabel(r)).toBe("Cafe X (cafe)");
	});

	it("maps named pedestrian area into address.pedestrian", () => {
		const r = landmarkToResult({ name: "Place A", type: "highway", subtype: "pedestrian", distanceM: 50 });
		expect(r.address.pedestrian).toBe("Place A");
		expect(placeLabel(r)).toBe("Place A (pedestrian)");
	});

	it("maps place=square into pedestrian (treated like a named open area)", () => {
		const r = landmarkToResult({ name: "Square S", type: "place", subtype: "square", distanceM: 30 });
		expect(r.address.pedestrian).toBe("Square S");
		expect(placeLabel(r)).toBe("Square S (square)");
	});
});

describe("refineMode", () => {
	it("upgrades driving to train when on rail at speed", () => {
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail", name: "Intercity" }];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("train");
		expect(r.confidence).toBe("high");
	});

	it("does not upgrade to train at low speed (might be near station, not on track)", () => {
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail" }];
		const r = refineMode("walking", 5, ways);
		expect(r.mode).not.toBe("train");
	});

	it("identifies cycling on cycleway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "cycleway" }];
		const r = refineMode("walking", 18, ways);
		expect(r.mode).toBe("cycling");
		expect(r.confidence).toBe("high");
	});

	it("confirms walking on footway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "footway" }];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking");
		expect(r.confidence).toBe("high");
	});

	// A walk down a city street renders with NO street name at all, because OSM
	// maps the pavement and the carriageway as two separate ways at the same
	// physical place — and the pavement is almost always unnamed. The closest way
	// to a walking GPS fix is therefore an anonymous `footway`, and reading its
	// `.name` yields nothing, even though the street is sitting right there in
	// the same result set.
	//
	// 2026-07-01 14:27, walking the length of Euston Road from Work to King's
	// Cross: the recorded ways at the samples are `footway (unnamed, 0-3 m)` and
	// `Euston Road [trunk, 0-2 m]`. The leg rendered as bare "walking".
	//
	// It was masked until now: the segment used to be glued to a tube ride, whose
	// speed pushed avgSpeed over the 30 km/h bar into the driveable branch, which
	// skips pedestrian ways and picks the road. The label was right by accident of
	// a wrong speed. Give the walk its real speed and the bug surfaces.
	//
	// The pavement is genuinely where the user is, so it must keep deciding the
	// MODE. It just cannot supply the NAME.
	describe("names a walk after the street its pavement belongs to", () => {
		it("borrows the adjacent road's name when the closest way is an unnamed pavement", () => {
			const ways: NearbyWay[] = [
				{ type: "highway", subtype: "footway", distanceM: 1 },
				{ type: "highway", subtype: "trunk", name: "Euston Road", distanceM: 3 },
			];
			const r = refineMode("walking", 4.5, ways);
			expect(r.mode).toBe("walking"); // the pavement still decides the mode
			expect(r.wayName).toBe("Euston Road"); // …but the street supplies the name
		});

		it("prefers the nearest named way, not merely the first in the list", () => {
			const ways: NearbyWay[] = [
				{ type: "highway", subtype: "footway", distanceM: 1 },
				{ type: "highway", subtype: "primary", name: "Gower Street", distanceM: 18 },
				{ type: "highway", subtype: "trunk", name: "Euston Road", distanceM: 4 },
			];
			expect(refineMode("walking", 4.5, ways).wayName).toBe("Euston Road");
		});

		it("keeps a named pedestrian way's own name rather than borrowing", () => {
			const ways: NearbyWay[] = [
				{ type: "highway", subtype: "pedestrian", name: "Tolmers Square", distanceM: 1 },
				{ type: "highway", subtype: "trunk", name: "Euston Road", distanceM: 20 },
			];
			expect(refineMode("walking", 4.5, ways).wayName).toBe("Tolmers Square");
		});

		// The guard. A footpath through a park is not on a street, and the road at
		// the park's edge is not where the user is walking. Naming the walk after
		// it would be exactly the confidently-wrong label this whole exercise is
		// about removing. Unnamed is the honest answer.
		it("does not borrow a road that is too far to be the same street", () => {
			const ways: NearbyWay[] = [
				{ type: "highway", subtype: "path", distanceM: 2 },
				{ type: "highway", subtype: "residential", name: "Some Road", distanceM: 70 },
			];
			expect(refineMode("walking", 4.5, ways).wayName).toBeUndefined();
		});
	});

	it("identifies driving on motorway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "motorway", name: "A2" }];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.confidence).toBe("high");
		expect(r.wayName).toBe("A2");
	});

	it("identifies plane on runway", () => {
		const ways: NearbyWay[] = [{ type: "aeroway", subtype: "runway" }];
		const r = refineMode("driving", 250, ways);
		expect(r.mode).toBe("plane");
		expect(r.confidence).toBe("high");
	});

	it("identifies stationary at airport", () => {
		const ways: NearbyWay[] = [{ type: "aeroway", subtype: "terminal" }];
		const r = refineMode("stationary", 0, ways);
		expect(r.mode).toBe("stationary");
		expect(r.reason).toContain("airport");
	});

	it("identifies boat on waterway", () => {
		const ways: NearbyWay[] = [{ type: "waterway", subtype: "river" }];
		const r = refineMode("driving", 20, ways);
		expect(r.mode).toBe("boat");
	});

	it("does NOT classify high-speed travel as boat (boats don't go 100 km/h)", () => {
		// Driving across a bridge — Overpass might return a waterway for the centroid
		const ways: NearbyWay[] = [{ type: "waterway", subtype: "river" }];
		const r = refineMode("driving", 101, ways);
		expect(r.mode).not.toBe("boat");
	});

	it("keeps original mode when no useful OSM context", () => {
		const r = refineMode("walking", 5, []);
		expect(r.mode).toBe("walking");
		expect(r.confidence).toBe("low");
	});

	it("railway at low speed near station does not falsely flag train", () => {
		// User walking through a station - railway nearby but slow speed
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail" }];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking"); // original kept
	});

	it("prefers motorway over parallel railway (Betuweroute parallels A15)", () => {
		// Parallel rail and motorway both nearby — the user is on the road, not the train.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute" },
			{ type: "highway", subtype: "motorway", name: "A15" },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("downgrades classifier 'train' to 'driving' when no rail anywhere", () => {
		// Cruise control on motorway looks like train (steady, linear, fast)
		// but there's no rail in the OSM samples.
		const ways: NearbyWay[] = [{ type: "highway", subtype: "motorway", name: "A2" }];
		const r = refineMode("train", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A2");
	});

	it("downgrades classifier 'train' to 'driving' even with no OSM context", () => {
		const r = refineMode("train", 100, []);
		expect(r.mode).toBe("driving");
		expect(r.reason).toContain("no rail evidence");
	});

	it("keeps 'train' when classifier said train AND rail is nearby with no major road", () => {
		// True train ride — rail is present, no parallel motorway
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail", name: "Hoofdspoor" }];
		const r = refineMode("train", 130, ways);
		expect(r.mode).toBe("train");
		expect(r.wayName).toBe("Hoofdspoor");
	});

	it("prefers a driveable road over a closer footway at driving speeds", () => {
		// Urban driving: GPS fix lands on the pavement next to a road.
		// The mirror returns a footway at 21m AND a parallel secondary
		// road at 27m, both within nearbyWays' 50m radius. Aggregation
		// by distance puts the footway first; the old refineMode
		// blindly picked highways[0] and labelled the segment "near
		// footway" despite the speed being clearly vehicular. At
		// driving speed the labeller must pass over pedestrian-only
		// ways and pick the closest car-road.
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "secondary", name: "Great Central Way" },
		];
		const r = refineMode("driving", 61, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("Great Central Way");
		expect(r.reason).toContain("secondary");
	});

	it("still picks the footway for walking speeds (no over-correction)", () => {
		// Same way list, walking speed — the user really IS on the
		// footway. The mode-aware filter must NOT kick in at walking
		// speeds; we want "on footway" here, not "on secondary".
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "secondary", name: "Some Road" },
		];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking");
		expect(r.reason).toContain("footway");
	});

	it("prefers train when rail is closer than parallel major road (tube under arterial)", () => {
		// Subway surface trace 20m from one sample, a primary road
		// 30m from the same sample. Old guard refused train because
		// a major highway was "present" anywhere → segment labelled
		// as driving. New distance-aware tie-break: rail closer than
		// road → train.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "subway", name: "Line J", distanceM: 20 },
			{ type: "highway", subtype: "primary", name: "Arterial Road", distanceM: 30 },
		];
		const r = refineMode("driving", 65, ways);
		expect(r.mode).toBe("train");
		expect(r.wayName).toBe("Line J");
	});

	it("keeps driving when major road is closer than parallel rail (Betuweroute)", () => {
		// Original Betuweroute case re-stated with distances: A15 at 10m
		// hugs the GPS trace, Betuweroute rail at 30m runs alongside.
		// Road closer → driving wins (old behaviour preserved by the
		// distance comparison, not by the presence rule).
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute", distanceM: 30 },
			{ type: "highway", subtype: "motorway", name: "A15", distanceM: 10 },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("falls back to presence-based rule when distanceM is missing (back-compat)", () => {
		// Callers that don't (yet) pass distanceM keep the original
		// behaviour: any major highway present blocks the train branch.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute" },
			{ type: "highway", subtype: "motorway", name: "A15" },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("falls back to the footway label when no driveable road is in range", () => {
		// Driving speed but only pedestrian-only ways nearby. The fix
		// shouldn't silently swallow this — the label still reflects
		// the only highway we can see ("near footway") rather than
		// pretending there's a road. Worth keeping because it makes the
		// regression case (the 13:29 drive when truly no road is in
		// range) visible in the UI rather than hidden behind a generic
		// fallback.
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "path" },
		];
		const r = refineMode("driving", 61, ways);
		expect(r.mode).toBe("driving");
		expect(r.reason).toContain("footway");
	});
});

describe("pickBestStation", () => {
	// When a rail run ends at an overground station, the first post-train
	// GPS fix is often 200-400m from the station (phone reports lag in
	// time + walking distance). Increasing the search radius brings the
	// real station into range, but also pulls in OSM's many `subway_
	// entrance` nodes labelled by letter (A, B, C, D, E). The picker must
	// prefer the actual station name over single-letter entrance labels.

	const s = (name: string, subtype: string, distanceM: number): NearbyStation => ({
		name,
		subtype,
		distanceM,
	});

	it("returns null for an empty list", () => {
		expect(pickBestStation([])).toBeNull();
	});

	it("prefers a station entry over closer entrance-letter labels", () => {
		// Real Station W dump from production:
		const out = pickBestStation([
			s("A", "subway_entrance", 242),
			s("B", "subway_entrance", 258),
			s("Station W", "subway", 260),
			s("C", "subway_entrance", 274),
		]);
		expect(out?.name).toBe("Station W");
	});

	it("falls back to the closest station when all are equivalent type", () => {
		const out = pickBestStation([s("Station K", "subway", 143), s("Station K Underground Station", "subway", 173)]);
		expect(out?.name).toBe("Station K");
	});

	it("falls back to entrance when no actual station is present", () => {
		// If a station node isn't tagged but only its entrances are, take
		// the closest entrance rather than returning nothing.
		const out = pickBestStation([s("A", "subway_entrance", 200), s("B", "subway_entrance", 220)]);
		expect(out?.name).toBe("A");
	});

	it("filters out single-letter names if a multi-letter alternative exists", () => {
		// Defensive: even if subtype info is missing/unreliable, a single-
		// letter name "A" is almost certainly an entrance label, not a
		// real station name.
		const out = pickBestStation([s("A", "subway", 240), s("Station W", "subway", 260)]);
		expect(out?.name).toBe("Station W");
	});
});

describe("dedupeStationsByName", () => {
	// OSM models a station and its entrances as separate points sharing the
	// station's name. The dedup logic must NOT lose the station-typed entry
	// when an entrance is closer — `pickBestStation` filters entrances out
	// later, and a station that survives dedup only as its entrance becomes
	// invisible to the picker, letting a further-away rival station win.
	type F = { name: string | null; derivedSubtype: string; distance_m: number };

	it("prefers a station-typed entry over a closer entrance with the same name", () => {
		const features: F[] = [
			{ name: "Station E", derivedSubtype: "subway_entrance", distance_m: 15 },
			{ name: "Station E", derivedSubtype: "subway", distance_m: 22 },
			{ name: "Station W", derivedSubtype: "rail", distance_m: 175 },
		];
		const result = dedupeStationsByName(features);
		const e = result.find((s) => s.name === "Station E");
		expect(e?.subtype).toBe("subway");
		expect(e?.distanceM).toBe(22);
	});

	it("keeps the entrance entry only when no station-typed sibling exists", () => {
		const features: F[] = [{ name: "Station X", derivedSubtype: "subway_entrance", distance_m: 30 }];
		const result = dedupeStationsByName(features);
		expect(result).toHaveLength(1);
		expect(result[0].subtype).toBe("subway_entrance");
	});

	it("picks the closer record when both are non-entrance", () => {
		const features: F[] = [
			{ name: "Station S", derivedSubtype: "subway", distance_m: 50 },
			{ name: "Station S", derivedSubtype: "subway", distance_m: 30 },
		];
		const result = dedupeStationsByName(features);
		expect(result[0].distanceM).toBe(30);
	});

	it("skips features with null names", () => {
		const features: F[] = [
			{ name: null, derivedSubtype: "subway_entrance", distance_m: 10 },
			{ name: "Station Q", derivedSubtype: "subway", distance_m: 50 },
		];
		expect(dedupeStationsByName(features)).toEqual([{ name: "Station Q", subtype: "subway", distanceM: 50 }]);
	});
});

describe("extractLineNames", () => {
	// Overpass returns relation elements that are route members of a stop
	// node near a queried point. We only want named route relations whose
	// route= tag identifies a rail-class line.
	it("returns the set of named rail lines from an Overpass response", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Jubilee Line" } },
				{ type: "relation", tags: { type: "route", route: "train", name: "Thameslink" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Metropolitan Line", "Jubilee Line", "Thameslink"]));
	});

	it("ignores non-route relations (e.g. boundaries, multipolygons)", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "boundary", name: "Greater London" } },
				{ type: "relation", tags: { type: "multipolygon", name: "Hyde Park" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Piccadilly Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Piccadilly Line"]));
	});

	it("ignores non-rail routes (bus, ferry, bicycle)", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "bus", name: "139" } },
				{ type: "relation", tags: { type: "route", route: "ferry", name: "Woolwich Ferry" } },
				{ type: "relation", tags: { type: "route", route: "bicycle", name: "NCN 4" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Victoria Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Victoria Line"]));
	});

	it("includes train, light_rail, tram, monorail as rail-class routes", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "train", name: "Elizabeth Line" } },
				{ type: "relation", tags: { type: "route", route: "light_rail", name: "DLR" } },
				{ type: "relation", tags: { type: "route", route: "tram", name: "Tramlink 1" } },
				{ type: "relation", tags: { type: "route", route: "monorail", name: "Disney Monorail" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Elizabeth Line", "DLR", "Tramlink 1", "Disney Monorail"]));
	});

	it("skips relations without a name tag", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Carfaxloo Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Carfaxloo Line"]));
	});

	it("deduplicates lines that appear in multiple route directions", () => {
		// OSM often has one route relation per direction or per service
		// variant (e.g. Met Line Aldgate-Uxbridge, Aldgate-Amersham). They
		// share the same name; we want the line counted once.
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Metropolitan Line"]));
	});

	it("returns an empty set for empty or undefined elements", () => {
		expect(extractLineNames({ elements: [] })).toEqual(new Set());
		expect(extractLineNames({})).toEqual(new Set());
	});

	it("ignores non-relation elements (ways, nodes)", () => {
		const data = {
			elements: [
				{ type: "node", tags: { railway: "station", name: "Station K" } },
				{ type: "way", tags: { highway: "primary", name: "Trunk Road" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Northern Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Northern Line"]));
	});
});

describe("isLodgingLandmark", () => {
	const lm = (type: NearbyLandmark["type"], subtype: string): NearbyLandmark => ({
		name: "X",
		type,
		subtype,
		distanceM: 0,
	});

	it("recognises tourism=guest_house as lodging", () => {
		expect(isLodgingLandmark(lm("tourism", "guest_house"))).toBe(true);
	});

	it("recognises tourism=hotel / hostel / motel / apartment as lodging", () => {
		expect(isLodgingLandmark(lm("tourism", "hotel"))).toBe(true);
		expect(isLodgingLandmark(lm("tourism", "hostel"))).toBe(true);
		expect(isLodgingLandmark(lm("tourism", "motel"))).toBe(true);
		expect(isLodgingLandmark(lm("tourism", "apartment"))).toBe(true);
	});

	it("rejects non-lodging tourism subtypes (museum, attraction, viewpoint)", () => {
		expect(isLodgingLandmark(lm("tourism", "museum"))).toBe(false);
		expect(isLodgingLandmark(lm("tourism", "attraction"))).toBe(false);
		expect(isLodgingLandmark(lm("tourism", "viewpoint"))).toBe(false);
	});

	it("rejects non-tourism types (amenity, shop, leisure)", () => {
		expect(isLodgingLandmark(lm("amenity", "restaurant"))).toBe(false);
		expect(isLodgingLandmark(lm("shop", "supermarket"))).toBe(false);
		expect(isLodgingLandmark(lm("leisure", "park"))).toBe(false);
	});
});

describe("pickLodgingOverride", () => {
	const lm = (type: NearbyLandmark["type"], subtype: string, distanceM: number, name = "X"): NearbyLandmark => ({
		name,
		type,
		subtype,
		distanceM,
	});

	it("picks the only nearby lodging landmark", () => {
		const out = pickLodgingOverride([
			lm("amenity", "restaurant", 10, "Cafe"),
			lm("tourism", "guest_house", 5, "Guesthouse Vertoef"),
		]);
		expect(out?.name).toBe("Guesthouse Vertoef");
	});

	it("returns the closest lodging when multiple lodgings match", () => {
		const out = pickLodgingOverride([
			lm("tourism", "hotel", 40, "Hotel Far"),
			lm("tourism", "guest_house", 5, "Guesthouse Near"),
			lm("tourism", "hostel", 25, "Hostel Mid"),
		]);
		expect(out?.name).toBe("Guesthouse Near");
	});

	it("returns null when no lodging landmark is nearby", () => {
		expect(
			pickLodgingOverride([
				lm("amenity", "restaurant", 10, "Cafe"),
				lm("tourism", "museum", 20, "Museum"),
				lm("shop", "supermarket", 30, "Shop"),
			]),
		).toBeNull();
	});

	it("returns null when a lodging exists but is beyond the override radius", () => {
		// 80 m is too far to call "where the user slept" without other
		// evidence — the user might just be sleeping in a building next
		// door. The override only fires for unambiguous proximity.
		expect(pickLodgingOverride([lm("tourism", "guest_house", 80, "Hotel Far")])).toBeNull();
	});

	it("returns null on empty input", () => {
		expect(pickLodgingOverride([])).toBeNull();
	});
});
