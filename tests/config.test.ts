import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadSyncConfig } from "../src/config.js";

const VALID_ENV = {
	AUTH_PORT: "3000",
	DB_HOST: "localhost",
	DB_PORT: "3306",
	DB_USER: "health",
	DB_PASSWORD: "pass",
	DB_NAME: "health",
	FITBIT_CLIENT_ID: "abc123",
	FITBIT_CLIENT_SECRET: "secret123",
	SESSION_SECRET: "at-least-sixteen-chars",
};

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = { ...process.env };
	Object.assign(process.env, VALID_ENV);
});

afterEach(() => {
	// Restore original env
	for (const key of Object.keys(VALID_ENV)) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("loadConfig", () => {
	it("parses valid env", () => {
		const config = loadConfig();
		expect(config.port).toBe(3000);
		expect(config.db.user).toBe("health");
		expect(config.fitbit.clientId).toBe("abc123");
		expect(config.nextcloud.baseUrl).toBe("https://dash.xinutec.org");
		expect(config.sessionSecret).toBe("at-least-sixteen-chars");
	});

	it("rejects missing session secret", () => {
		delete process.env.SESSION_SECRET;
		expect(() => loadConfig()).toThrow();
	});

	it("rejects short session secret", () => {
		process.env.SESSION_SECRET = "short";
		expect(() => loadConfig()).toThrow();
	});

	it("rejects missing DB user", () => {
		delete process.env.DB_USER;
		expect(() => loadConfig()).toThrow();
	});

	it("rejects missing Fitbit client ID", () => {
		delete process.env.FITBIT_CLIENT_ID;
		expect(() => loadConfig()).toThrow();
	});
});

describe("loadSyncConfig", () => {
	it("parses valid env (no OAuth config needed)", () => {
		const config = loadSyncConfig();
		expect(config.db.user).toBe("health");
		expect(config.fitbit.clientId).toBe("abc123");
	});

	it("rejects missing Fitbit client secret", () => {
		delete process.env.FITBIT_CLIENT_SECRET;
		expect(() => loadSyncConfig()).toThrow();
	});
});
