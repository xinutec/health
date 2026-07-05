import { z } from "zod";

const schema = z.object({
	port: z.coerce.number().default(3000),

	db: z.object({
		host: z.string().default("health-db"),
		port: z.coerce.number().default(3306),
		user: z.string(),
		password: z.string(),
		database: z.string().default("health"),
	}),

	fitbit: z.object({
		clientId: z.string().min(1),
		clientSecret: z.string().min(1),
		redirectUri: z.string().url().default("https://health.xinutec.org/fitbit/callback"),
	}),

	nextcloud: z.object({
		// Just the base URL — auth is via Login Flow v2 app passwords
		// per user, stored in `nc_credentials`. No OAuth client_id /
		// client_secret needed.
		baseUrl: z.string().url().default("https://dash.xinutec.org"),
	}),

	owntracks: z.object({
		/** Comma-separated list of PhoneTrack session tokens this proxy
		 *  is willing to forward. Requests for any other token are
		 *  rejected before touching upstream — protects both Nextcloud
		 *  (no wasted brute-force-counter increments) and our own
		 *  in-process state maps (no attacker-controlled growth). */
		allowedTokens: z
			.string()
			.transform((s) =>
				s
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0),
			)
			.pipe(z.array(z.string().min(8))),
	}),

	sessionSecret: z.string().min(16),

	/** Public origin where the dashboard is reachable. Used by the
	 *  share feature to compose URLs that get sent to recipients. */
	publicBaseUrl: z.string().url().default("https://health.xinutec.org"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
	return schema.parse({
		port: process.env.AUTH_PORT,
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		fitbit: {
			clientId: process.env.FITBIT_CLIENT_ID,
			clientSecret: process.env.FITBIT_CLIENT_SECRET,
			redirectUri: process.env.FITBIT_REDIRECT_URI,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
		},
		owntracks: {
			allowedTokens: process.env.OWNTRACKS_ALLOWED_TOKENS ?? "",
		},
		sessionSecret: process.env.SESSION_SECRET,
		publicBaseUrl: process.env.PUBLIC_BASE_URL,
	});
}

// Config for sync job. Fitbit creds are required; Nextcloud is just
// a base URL — per-user app passwords live in nc_credentials.
export function loadSyncConfig() {
	return z
		.object({
			db: schema.shape.db,
			fitbit: z.object({
				clientId: z.string().min(1),
				clientSecret: z.string().min(1),
			}),
			nextcloud: z
				.object({
					baseUrl: z.string().url().default("https://dash.xinutec.org"),
				})
				.nullable(),
		})
		.parse({
			db: {
				host: process.env.DB_HOST,
				port: process.env.DB_PORT,
				user: process.env.DB_USER,
				password: process.env.DB_PASSWORD,
				database: process.env.DB_NAME,
			},
			fitbit: {
				clientId: process.env.FITBIT_CLIENT_ID,
				clientSecret: process.env.FITBIT_CLIENT_SECRET,
			},
			nextcloud: process.env.NC_BASE_URL ? { baseUrl: process.env.NC_BASE_URL } : null,
		});
}
