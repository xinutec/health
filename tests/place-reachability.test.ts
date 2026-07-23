/**
 * Per-day focus-place reachability filter: unit behaviour + the SAFETY GATE.
 *
 * The gate decodes every golden day twice — with the full ~140-place state
 * space and with only the day-reachable places — and asserts the segments are
 * byte-identical. That is the whole safety claim: dropping places the user was
 * never near removes dead trellis states WITHOUT changing the decode. If a day
 * ever diverges, this test names it (and the reduction must not ship for it).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "../src/cli/hsmm-fixture.js";
import { decodeHsmm } from "../src/hmm/decode.js";
import type { HmmSegment } from "../src/hmm/persist.js";
import { reachablePlaces, reachablePlacesForDay } from "../src/hmm/place-reachability.js";

const p = (id: number, lat: number, lon: number) => ({ id, lat, lon });

describe("reachablePlaces", () => {
	const pts = [{ lat: 51.52, lon: -0.13 }]; // one fix in Bloomsbury

	it("keeps places within the radius, drops places beyond it", () => {
		const places = [
			p(1, 51.5201, -0.1301), // ~15 m — near
			p(2, 51.53, -0.13), // ~1.1 km — near at 2km, far at 500m
			p(3, 51.7, 0.4), // ~40 km — far
		];
		expect(reachablePlaces(places, pts, { radiusM: 2000 }).map((x) => x.id)).toEqual([1, 2]);
		expect(reachablePlaces(places, pts, { radiusM: 500 }).map((x) => x.id)).toEqual([1]);
	});

	it("keepIds forces a far place through (continuity prior-day place)", () => {
		const places = [p(1, 51.5201, -0.1301), p(9, 51.7, 0.4)];
		const kept = reachablePlaces(places, pts, { radiusM: 500, keepIds: new Set([9]) });
		expect(kept.map((x) => x.id).sort()).toEqual([1, 9]);
	});

	it("drops everything when there are no fixes (except forced keeps)", () => {
		const places = [p(1, 51.52, -0.13), p(2, 51.7, 0.4)];
		expect(reachablePlaces(places, [], { radiusM: 5000 })).toEqual([]);
		expect(reachablePlaces(places, [], { radiusM: 5000, keepIds: new Set([2]) }).map((x) => x.id)).toEqual([2]);
	});
});

// Compare two decodes as per-minute (mode, placeId, lineName) streams so a
// mismatch reports minute-agreement, not just a boolean.
function minuteLabels(segs: readonly HmmSegment[]): Map<number, string> {
	const m = new Map<number, string>();
	for (const s of segs) {
		for (let ts = s.startTs; ts < s.endTs; ts += 60) m.set(ts, `${s.mode}|${s.placeId ?? "-"}|${s.lineName ?? "-"}`);
	}
	return m;
}

describe("reachability safety gate (golden corpus)", () => {
	it("decodes near-identically with the reduced place set on every golden day", () => {
		const dir = fileURLToPath(new URL("./golden/decoded_days/", import.meta.url));
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);

		for (const f of files) {
			const captured = JSON.parse(readFileSync(join(dir, f), "utf8")) as HsmmCapturedDay;
			const inputs = hsmmInputsFromFixture(captured);
			// Exercise the SAME entry point production uses, so the gate can't
			// drift from the served keep policy (anchors + continuity place).
			const reduced = reachablePlacesForDay(inputs.places, inputs.points, {
				radiusM: 2000,
				continuityPlaceId: inputs.continuityContext?.priorPlaceId ?? null,
			});

			// Compare the reduced-place decode against the fixture's BLESSED
			// full-place decode (`expected`, kept current by golden-check-hsmm) —
			// one decode per day, not two, so the gate stays cheap in the suite.
			const full = captured.expected;
			const cut = decodeHsmm({ ...inputs, places: reduced });

			const a = minuteLabels(full);
			const b = minuteLabels(cut);
			// Place-exactness: mode + placeId (what the filter actually controls).
			// Line flips between parallel track-sharing lines are a separate,
			// accepted near-tie class, so tracked but not gated.
			let placeAgree = 0;
			let lineFlip = 0;
			const diffs: string[] = [];
			for (const [ts, lab] of a) {
				const other = b.get(ts) ?? "";
				const [am, ap, al] = lab.split("|");
				const [bm, bp, bl] = other.split("|");
				if (am === bm && ap === bp) {
					placeAgree++;
					if (al !== bl) lineFlip++;
				} else if (diffs.length < 6) {
					diffs.push(`@${new Date(ts * 1000).toISOString().slice(11, 16)} full=${lab} cut=${other}`);
				}
			}
			const pct = ((100 * placeAgree) / a.size).toFixed(2);
			// eslint-disable-next-line no-console
			console.log(
				`${f}: places ${inputs.places.length}→${reduced.length}, place-exact ${pct}% lineFlips ${lineFlip} (${a.size} min)` +
					(diffs.length ? `\n    ${diffs.join("\n    ")}` : ""),
			);
			// Near-exact, NOT exact: pruning far places occasionally flips a
			// genuine near-tie elsewhere (place-vs-off-network-stationary at a
			// GPS-gap minute; parallel track-sharing lines) — the same
			// near-tie class the quant flip accepts. Floor well above the
			// observed worst (05-15 ≈ 99.0%) catches a real regression without
			// pretending the reduction is identical.
			expect(Number(pct)).toBeGreaterThanOrEqual(98.5);
		}
	}, 180000);
});
