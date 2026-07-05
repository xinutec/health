import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const USER = "pippijn";

// Cleveland Clinic London is at ~51.4997, -0.1488.
// Home is at ~51.553, -0.286 (Wembley).
// Show every focus_place within ~5km of either.
const rows = await c.query(
	`SELECT id, centroid_lat, centroid_lon, radius_m, display_name, detected_label,
	        sleep_hours, unique_days, amenity_label, first_seen_ts, last_seen_ts, refreshed_at
	 FROM focus_places
	 WHERE user_id = ?
	 ORDER BY sleep_hours DESC`,
	[USER],
);

const dist = (lat1, lon1, lat2, lon2) => {
	const R = 6371000;
	const phi1 = (lat1 * Math.PI) / 180;
	const phi2 = (lat2 * Math.PI) / 180;
	const dphi = phi2 - phi1;
	const dlam = ((lon2 - lon1) * Math.PI) / 180;
	const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
	return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

console.log(`Total focus_places for ${USER}: ${rows.length}\n`);
console.log(`id  display_name           detected  lat,lon                  r  sleep_h  unique  amenity_label`);
console.log(`-`.repeat(140));
for (const r of rows) {
	const lat = Number(r.centroid_lat);
	const lon = Number(r.centroid_lon);
	const dHome = dist(lat, lon, 51.553, -0.286);
	const dCC = dist(lat, lon, 51.4997, -0.1488);
	const near = dHome < 1000 ? "(near HOME)" : dCC < 1000 ? "(near CLEVELAND CLINIC)" : "";
	console.log(
		`${String(r.id).padStart(3)}  ${(r.display_name ?? "—").padEnd(22)}  ${(r.detected_label ?? "—").padEnd(8)}  ` +
			`${lat.toFixed(4)},${lon.toFixed(4)}  ${r.radius_m}m  ${String(r.sleep_hours).padStart(6)}  ${String(r.unique_days).padStart(5)}  ` +
			`${(r.amenity_label ?? "—").slice(0, 30).padEnd(30)} ${near}`,
	);
}

await c.end();
