// The app-specific half of the shared phone-width harness (@xinutec/ui-harness).
// Read by BOTH playwright.config.ts and the harness's static server, so there is
// one place to say what this app is and no port to keep in step — the port is
// allocated from `app`.

/** @type {import('@xinutec/ui-harness/config').HarnessSpec} */
export default {
	app: 'health',
	dist: 'dist/frontend/browser',
	// Fallback stub only — the specs page.route everything. Real prod is the Rust
	// backend. Signed-in and Fitbit-linked so an un-mocked run still leaves the
	// shell.
	api: {
		'/api/me': {
			userId: 'test',
			displayName: 'Test',
			fitbitLinked: true,
			connections: { nextcloud: { status: 'active' }, fitbit: { status: 'active' } },
			shareWindow: null,
		},
		'/api/location/latest': null,
	},
};
