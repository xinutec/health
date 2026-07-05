import { describe, it } from "vitest";

/**
 * Define a test suite that needs a captured real-data fixture.
 *
 * These fixtures are gitignored — they hold private location traces — so
 * they are absent in CI and on any fresh checkout. `describe.skipIf`
 * alone is not enough: Vitest still *executes the suite callback at
 * collection time* to discover the tests, so a body that dereferences
 * the (null) fixture — or asserts it non-null with a throw — fails the
 * whole file before a single test runs.
 *
 * This helper gates the body itself. When `fixture` is null it collects
 * a single skipped placeholder and never touches the body; when present
 * it runs `body` with the fixture narrowed non-null. The same `npm test`
 * command therefore exercises these suites locally (fixture present) and
 * cleanly skips them in CI (fixture absent) — no separate exclude list.
 */
export function describeWithFixture<T>(name: string, fixture: T | null, body: (fixture: T) => void): void {
	if (fixture === null) {
		describe.skip(`${name} (fixture absent)`, () => {
			it("requires a local captured fixture", () => {});
		});
		return;
	}
	describe(name, () => body(fixture));
}
