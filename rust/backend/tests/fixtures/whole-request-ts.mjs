// Prints the TypeScript's day-fold request for one captured day, so
// tests/fold_request_corpus.rs can diff against the REAL encoder rather than a
// stored copy that could drift from dist/.
//
// Usage: node whole-request-ts.mjs <day>.json     (FOLD_CAPTURE selects the dir)
import { readFileSync } from "node:fs";
import { buildDayRequest } from "../../../../dist/lean/fold-payload.js";

const name = process.argv[2];
const caps = process.env.FOLD_CAPTURE ?? "/tmp/foldcap";
const root = new URL("../../../../", import.meta.url).pathname;
const cap = JSON.parse(readFileSync(`${caps}/${name}`, "utf8"));
const fx = JSON.parse(readFileSync(`${root}tests/golden/days/${name}`, "utf8"));
process.stdout.write(JSON.stringify(buildDayRequest(cap, fx.inputs, fx.inputs.osmTrace)));
