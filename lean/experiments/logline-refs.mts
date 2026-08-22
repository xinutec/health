#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.LogLine` from V8 — and derive the
 * Unicode tables themselves.
 *
 * `oneLine` is the security boundary of `/api/telemetry`: client UI text goes
 * into a log line as `label=…`, so a newline inside it forges WHOLE LOG LINES,
 * including further `client-event` lines attributed to someone else. A log that
 * can be written into by the thing it observes is not evidence.
 *
 * ⚠ The rule depends on Unicode categories (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`) and on
 * `\s`, and Lean has neither. Rather than transcribe a Unicode chart and hope it
 * matches whichever Unicode version this Node was built against, this ENUMERATES
 * EVERY CODE POINT and asks V8. The ranges printed below are the ones pasted
 * into `Verified/LogLine.lean`, so the table has a provenance rather than an
 * author.
 *
 * ⚠ That makes the Lean table a snapshot of ONE ENGINE VERSION. Re-run this on
 * any Node upgrade: a newer Unicode could add a `Cf` code point the table does
 * not know, which would then pass through unflattened.
 *
 * Run: npx tsx lean/experiments/logline-refs.mts
 */
import { oneLine } from "../../src/routes/api.js";

const catRe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const wsRe = /\s/;

function ranges(pred: (s: string) => boolean): [number, number][] {
	const out: [number, number][] = [];
	let start = -1;
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		// Surrogates are not scalar values; skip rather than test half a pair.
		const isSurrogate = cp >= 0xd800 && cp <= 0xdfff;
		const m = !isSurrogate && pred(String.fromCodePoint(cp));
		if (m && start < 0) start = cp;
		if (!m && start >= 0) {
			out.push([start, cp - 1]);
			start = -1;
		}
	}
	if (start >= 0) out.push([start, 0x10ffff]);
	return out;
}

console.log("--- the tables, as V8 classifies every code point ---");
const cat = ranges((s) => catRe.test(s));
const ws = ranges((s) => wsRe.test(s));
console.log(`Cc|Cf|Zl|Zp: ${cat.length} ranges`);
console.log(JSON.stringify(cat));
console.log(`\\s: ${ws.length} ranges`);
console.log(JSON.stringify(ws));
// ⚠ Neither set contains the other. These survive the category replacement and
// are collapsed by the whitespace one — a host that used a single set would
// either leak a separator or eat a non-breaking space.
console.log(
	"whitespace that is NOT control-like:",
	JSON.stringify(ws.filter(([a, b]) => !cat.some(([c, d]) => a >= c && b <= d))),
);

console.log("--- oneLine(raw, max), from the production function ---");
const cases: [string, number][] = [
	["Refresh", 160],
	["", 160],
	// ⚠ THE ATTACK: a forged second log line.
	["a\nclient-event user=victim", 160],
	["a\rb", 160],
	["a\r\nb", 160],
	["a b", 160],
	["a b", 160],
	["a‮b", 160],
	["a​b", 160],
	["a﻿b", 160],
	["a   b", 160],
	["  a  b  ", 160],
	["\t\n\r a", 160],
	["   ", 160],
	["a b", 160],
	["a　b", 160],
	["abcdef", 3],
	["abc", 10],
	["abcdef", 0],
	["\u{1D11E}\u{1D11E}\u{1D11E}", 2],
];
for (const [raw, max] of cases) {
	const out = oneLine(raw, max);
	console.log(`oneLine(${JSON.stringify(raw)}, ${max}) = ${JSON.stringify(out)} len=${[...out].length}`);
}
