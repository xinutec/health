// One-shot: for a set of GPS fixes, report distance to nearest rail-only
// OSM way and nearest drivable road. Used to validate the rail-corridor
// signal hypothesis on a specific failing-day fix sequence before
// implementing the factor.
import { createConnection } from "mariadb";
import { readFileSync } from "node:fs";

const fixturePath = process.argv[2];
const startUtc = process.argv[3]; // "12:16" (UTC)
const endUtc = process.argv[4]; // "12:26" (UTC)
const tz = process.argv[5] ?? "Europe/London"; // display only
if (!fixturePath || !startUtc || !endUtc) {
	console.error("usage: check-rail-proximity.mjs <fixture.json> <start HH:MM UTC> <end HH:MM UTC> [tz-for-display]");
	process.exit(2);
}

const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const fmt = (ts) =>
	new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const date = fx.date;
const lo = new Date(`${date}T${startUtc}:00Z`).getTime() / 1000;
const hi = new Date(`${date}T${endUtc}:00Z`).getTime() / 1000;

const fixes = fx.points.filter((p) => p.ts >= lo && p.ts <= hi);
if (fixes.length === 0) {
	console.error("no fixes in window");
	process.exit(1);
}
console.error(`window ${startUtc}-${endUtc} UTC: ${fixes.length} fixes (display tz=${tz})`);

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const RAIL_SUBTYPES = ["rail", "subway", "light_rail"]; // exclude tram (mixed traffic)
const DRIVABLE_SUBTYPES = [
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
];

const ridSet = `('${RAIL_SUBTYPES.join("','")}')`;
const drvSet = `('${DRIVABLE_SUBTYPES.join("','")}')`;

const rows = [];
for (const f of fixes) {
	const point = `POINT(${f.lon} ${f.lat})`;
	const [railRow] = await c.query(
		`SELECT name, subtype, ST_Distance(geom, ST_GeomFromText(?)) AS dist_deg
		 FROM osm_lines
		 WHERE feature_type = 'railway' AND subtype IN ${ridSet}
		   AND MBRIntersects(geom, ST_Buffer(ST_GeomFromText(?), 0.005))
		 ORDER BY dist_deg LIMIT 1`,
		[point, point],
	);
	const [roadRow] = await c.query(
		`SELECT name, subtype, ST_Distance(geom, ST_GeomFromText(?)) AS dist_deg
		 FROM osm_lines
		 WHERE feature_type = 'highway' AND subtype IN ${drvSet}
		   AND MBRIntersects(geom, ST_Buffer(ST_GeomFromText(?), 0.005))
		 ORDER BY dist_deg LIMIT 1`,
		[point, point],
	);
	// Crude degree→metre conversion (lat-dependent); fine for ranking.
	const mPerDeg = 111_000;
	rows.push({
		t: fmt(f.ts),
		railName: railRow?.name ?? null,
		railSubtype: railRow?.subtype ?? null,
		railDistM: railRow ? Math.round(Number(railRow.dist_deg) * mPerDeg) : null,
		roadName: roadRow?.name ?? null,
		roadSubtype: roadRow?.subtype ?? null,
		roadDistM: roadRow ? Math.round(Number(roadRow.dist_deg) * mPerDeg) : null,
		speed: f.speed_kmh,
	});
}

console.table(rows);

const railClose = rows.filter((r) => r.railDistM !== null && r.railDistM < 100).length;
const roadClose = rows.filter((r) => r.roadDistM !== null && r.roadDistM < 100).length;
console.log(`\n=== summary ===`);
console.log(`fixes near rail (<100m): ${railClose} / ${rows.length}`);
console.log(`fixes near drivable road (<100m): ${roadClose} / ${rows.length}`);

await c.end();
