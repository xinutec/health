// Generates encode-seg-ts.json: the ORACLE for src/fold_payload.rs's encode_seg,
// produced by running the real `encodeSeg` from dist/lean/fold-payload.js over
// segments taken from the golden corpus's fold captures.
//
// Regenerate with:
//   FOLD_CAPTURE=/tmp/foldcap nix develop . -c node dist/cli/golden-check.js
//   nix develop . -c node rust/backend/tests/fixtures/encode-seg-ts.mjs
//
// ⚠ The segments are SYNTHETIC-SAFE: only the encoding-relevant scalar fields
// travel, and place/city/wayName are replaced with neutral markers. The corpus
// itself is gitignored because it carries real coordinates and place names; this
// fixture must be committable, so it keeps the SHAPES and drops the content.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { encodeSeg } from "../../../../dist/lean/fold-payload.js";

const CAP = process.env.FOLD_CAPTURE ?? "/tmp/foldcap";
const scrub = (s, i) => {
	const o = { ...s };
	if (o.place != null) o.place = `place-${i % 7}`;
	if (o.city != null) o.city = `city-${i % 3}`;
	if (o.wayName != null) o.wayName = `way-${i % 5}`;
	// Coordinates decide nothing about the ENCODING, only about its input, so
	// they are shifted to a fixed offset rather than dropped: the bit-pattern
	// path still has to survive a full-precision double.
	for (const k of ["centroidLat", "centroidLon"]) if (typeof o[k] === "number") o[k] = (o[k] % 1) + 1;
	for (const k of ["snappedPath", "matchedPath", "walkMatchedPath", "walkSmoothedPath"]) {
		if (Array.isArray(o[k])) o[k] = o[k].slice(0, 3).map((p) => ({ lat: (p.lat % 1) + 1, lon: (p.lon % 1) + 1, ts: p.ts }));
	}
	return o;
};

const out = [];
let i = 0;
for (const f of readdirSync(CAP).sort()) {
	if (!f.endsWith(".json")) continue;
	const cap = JSON.parse(readFileSync(`${CAP}/${f}`, "utf8"));
	// `segsOut` carries the ENRICHED shape (paths, biometrics, refinedKinds);
	// `segsRaw` carries the bare one. Both matter — the encoder must handle a
	// segment that has been through the whole cascade and one that has not.
	for (const key of ["segsRaw", "segsOut"]) {
		for (const s of (cap[key] ?? []).slice(0, 4)) {
			const scrubbed = scrub(s, i++);
			out.push({ in: scrubbed, out: encodeSeg(scrubbed) });
		}
	}
}
writeFileSync(new URL("./encode-seg-ts.json", import.meta.url), JSON.stringify(out, null, 1));
console.error(`${out.length} segments`);
