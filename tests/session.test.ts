import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "../src/middleware/session.js";

const SECRET = "test-secret-at-least-16-chars";

describe("signValue / verifyValue", () => {
	it("round-trips a value", () => {
		const signed = signValue(SECRET, "hello");
		expect(verifyValue(SECRET, signed)).toBe("hello");
	});

	it("rejects tampered value", () => {
		const signed = signValue(SECRET, "hello");
		const tampered = `tampered${signed.slice(5)}`;
		expect(verifyValue(SECRET, tampered)).toBeNull();
	});

	it("rejects tampered signature", () => {
		const signed = signValue(SECRET, "hello");
		const tampered = `${signed.slice(0, -3)}xxx`;
		expect(verifyValue(SECRET, tampered)).toBeNull();
	});

	it("rejects wrong secret", () => {
		const signed = signValue(SECRET, "hello");
		expect(verifyValue("wrong-secret-also-long", signed)).toBeNull();
	});

	it("rejects empty string", () => {
		expect(verifyValue(SECRET, "")).toBeNull();
	});

	it("rejects string without dot", () => {
		expect(verifyValue(SECRET, "nodot")).toBeNull();
	});

	it("rejects signature with wrong length (no crash)", () => {
		expect(verifyValue(SECRET, "value.short")).toBeNull();
		expect(verifyValue(SECRET, "value.")).toBeNull();
		expect(verifyValue(SECRET, `value.${"a".repeat(200)}`)).toBeNull();
	});
});

// Session lifecycle tests (createSession, getSession, destroySession)
// require a DB connection. These are integration tests that should run
// against a real or test database — not included in the unit test suite.
