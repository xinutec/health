import { beforeEach, describe, expect, it } from "vitest";
import { clearAllStates, consumeState, createState } from "../src/middleware/oauth-state.js";

beforeEach(() => clearAllStates());

describe("OAuth state", () => {
	it("creates and consumes a state", () => {
		const state = createState({ userId: "alice" });
		const pending = consumeState(state);
		expect(pending).not.toBeNull();
		expect(pending?.userId).toBe("alice");
	});

	it("rejects replay (consumed state cannot be reused)", () => {
		const state = createState();
		expect(consumeState(state)).not.toBeNull();
		expect(consumeState(state)).toBeNull();
	});

	it("rejects unknown state", () => {
		expect(consumeState("unknown-state")).toBeNull();
	});

	it("stores codeVerifier", () => {
		const state = createState({ codeVerifier: "my-verifier", userId: "bob" });
		const pending = consumeState(state);
		expect(pending?.codeVerifier).toBe("my-verifier");
		expect(pending?.userId).toBe("bob");
	});

	it("each state is unique", () => {
		const s1 = createState();
		const s2 = createState();
		expect(s1).not.toBe(s2);
	});
});
