/**
 * Parser for `tests/golden/ground-truth/YYYY-MM-DD.md` audit tables.
 *
 * Each ground-truth file has a free-text narrative followed by an
 * `## Audit of ...` section containing a markdown table. The table is
 * the structured truth signal: per-window status (`correct` / `wrong`
 * / `partial` / `unclear`) plus, when blessed-cell content matches
 * what actually happened, the cell content IS the ground-truth state.
 *
 * Why a parser exists at all:
 *
 *   The HMM and pipeline have been measured against either each other
 *   (`compare-hmm-vs-heuristic`) or against previously-blessed pipeline
 *   output (`npm run golden`) — both self-referential. The narratives
 *   are the actual truth signal, but were a manual-only reference
 *   until this module. Programmatic comparison vs ground truth is the
 *   precondition for honest evaluation of any classification change.
 *
 * Pure module. No DB, no IO, no globals.
 */

import { fitbitTsToUnix } from "../geo/timezone.js";

export type AuditStatus = "correct" | "wrong" | "partial" | "unclear";

/**
 * How a ground-truth verdict is known — the provenance ladder, strongest
 * first. A verdict's *status* says what is true; its *provenance* says how
 * much to trust that claim, which is what stops a pipeline guess from
 * masquerading as fact.
 *
 *   - `corroborated` — independent sources agree (e.g. GPS + watch + an
 *     external record like a hospital dossier). Strongest; beats memory.
 *   - `user` — the user stated it directly, no external record.
 *   - `derived` — computed from the raw signal (cadence / physics / GPS
 *     proximity). Re-verifiable and immune to label contamination.
 *   - `inferred` — read back from the pipeline's own output. This is NOT
 *     truth; it can only ever be a hypothesis. The 2026-04-29 "hair
 *     appointment" was this, wearing a `correct` badge.
 *   - `unspecified` — no provenance tag present. Treated as untrustworthy
 *     (same gate as `inferred`) so an un-annotated legacy row never
 *     silently gates a regression check.
 *
 * Tagged inline in an audit row with `{user}` / `{derived}` /
 * `{corroborated}` / `{inferred}` (in the status or notes cell).
 */
export type Provenance = "corroborated" | "user" | "derived" | "inferred" | "unspecified";

/** Provenance values trustworthy enough to gate a verification check. A
 *  `correct`/`wrong` verdict only becomes an enforceable truth when its
 *  provenance clears this bar — `inferred` and `unspecified` never do. */
export const TRUSTED_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["corroborated", "user", "derived"]);

/** Read a provenance tag (`{user}`, `{derived}`, `{corroborated}`,
 *  `{inferred}`) from free-text. Returns `unspecified` when no tag is
 *  present. Case-insensitive; the first recognised tag wins. */
export function parseProvenance(text: string): Provenance {
	const m = text.toLowerCase().match(/\{(corroborated|user|derived|inferred)\}/);
	return (m?.[1] as Provenance) ?? "unspecified";
}

/** Is this row an enforceable truth — a definite verdict (`correct` or
 *  `wrong`) backed by trustworthy provenance? Only such rows should gate a
 *  pipeline-vs-truth check; `partial`/`unclear` verdicts and
 *  `inferred`/`unspecified` provenance are advisory, never enforced. */
export function isEnforceableTruth(row: Pick<GroundTruthRow, "status" | "provenance">): boolean {
	if (row.status !== "correct" && row.status !== "wrong") return false;
	return TRUSTED_PROVENANCE.has(row.provenance);
}

export type GroundTruthMode = "sleeping" | "stationary" | "walking" | "cycling" | "driving" | "bus" | "train" | "plane";

export interface ParsedBlessed {
	mode: GroundTruthMode;
	/** Focus-place name (e.g. "Home", "Cleveland Clinic London"). `null`
	 *  for movement modes or train. */
	place: string | null;
	/** OSM way name when the blessed cell is "walking on X" or
	 *  "driving on X". Distinct from `place` — a way attribution is
	 *  weaker signal (it's just the nearest road, not a destination). */
	wayName: string | null;
	/** Trailing parenthetical qualifier — e.g. "(hotel)" on
	 *  "Parkhotel Den Haag (hotel)" surfaces the amenity classification
	 *  the pipeline emitted. Useful diagnostic when place names match
	 *  but the qualifier reveals a wrong-amenity attribution. */
	placeQualifier: string | null;
	/** Train boarding + alighting station names. `null` for non-train
	 *  modes. */
	trainFromTo: { from: string; to: string } | null;
	/** Named rail line (e.g. "Metropolitan Line"). `null` when the
	 *  blessed cell omits the `· Line Name` suffix (which itself is a
	 *  partial-attribution signal). */
	lineName: string | null;
}

export interface GroundTruthRow {
	/** Original window text from the table — e.g. "13:02 – 13:16". */
	windowText: string;
	/** UTC unix seconds of the window's start. */
	startTs: number;
	/** UTC unix seconds of the window's end (exclusive). When the end
	 *  hour:minute is less than the start, the window crosses midnight
	 *  and `endTs` is the next calendar day. */
	endTs: number;
	/** Original blessed-cell text, verbatim — kept so diagnostics can
	 *  show the human-readable reference even when `blessed` failed to
	 *  parse into structured form. */
	blessedText: string;
	/** Structured form of the blessed cell. `null` when the cell didn't
	 *  match any known shape (e.g. an "unlabelled sliver" or some other
	 *  edge case in the narrative). */
	blessed: ParsedBlessed | null;
	status: AuditStatus;
	/** How this verdict is known — see {@link Provenance}. Parsed from an
	 *  inline `{...}` tag in the status or notes cell; `unspecified` when
	 *  absent. Determines whether the verdict can gate a verification check
	 *  (see {@link isEnforceableTruth}). */
	provenance: Provenance;
	/** Raw status cell, useful for diagnostics. */
	statusText: string;
	/** "Correct version" or trailing-notes cell content — free-text the
	 *  human wrote describing what should have been emitted. `null` if
	 *  the cell is empty or absent. NOT parsed structurally — captured
	 *  for diagnostic display only. */
	correctVersionText: string | null;
}

export interface GroundTruthDay {
	/** Local date "YYYY-MM-DD" the file describes. */
	date: string;
	/** Timezone in which the table's HH:MM times are interpreted. */
	tz: string;
	rows: GroundTruthRow[];
}

const AUDIT_HEADING = /^##\s+Audit\s+of\s+/i;
const HEADING = /^##\s+/;
const TABLE_ROW = /^\s*\|/;

/** Raw row before day-anchoring: just the parsed window HH:MM values. */
interface RawRow {
	windowText: string;
	startHh: number;
	startMm: number;
	endHh: number;
	endMm: number;
	blessedText: string;
	statusText: string;
	correctVersionText: string | null;
}

/** Parse a single ground-truth markdown file into structured form.
 *
 *  Day-anchoring convention: rows are walked in table order, tracking
 *  a "current day cursor." When a row's start time decreases relative
 *  to the previous row, the cursor advances by 1 day — that's how
 *  the audit tables encode "tonight's sleep" rows at the bottom that
 *  belong to the next calendar day.
 *
 *  The first row's anchor is yesterday IF it starts after noon
 *  (representing the previous evening's sleep continuing into the
 *  file's date), otherwise today. This matches the convention used
 *  across all blessed ground-truth files. */
export function parseGroundTruth(markdown: string, date: string, tz: string): GroundTruthDay {
	const lines = markdown.split("\n");
	const rawRows: RawRow[] = [];

	let inAudit = false;
	for (const line of lines) {
		if (AUDIT_HEADING.test(line)) {
			inAudit = true;
			continue;
		}
		if (inAudit && HEADING.test(line)) break;
		if (!inAudit) continue;
		if (!TABLE_ROW.test(line)) continue;

		const cells = splitTableRow(line);
		if (cells.length < 3) continue;
		if (isHeaderRow(cells)) continue;
		if (isSeparatorRow(cells)) continue;

		const windowText = cells[0].trim();
		const m = /^(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})$/.exec(windowText);
		if (!m) continue;

		const blessedText = cells[1].trim();
		const statusText = cells[2].trim();
		const correctVersion = cells.length >= 4 ? cells.slice(3).join("|").trim() : "";

		rawRows.push({
			windowText,
			startHh: Number(m[1]),
			startMm: Number(m[2]),
			endHh: Number(m[3]),
			endMm: Number(m[4]),
			blessedText,
			statusText,
			correctVersionText: correctVersion.length === 0 ? null : correctVersion,
		});
	}

	// Day-anchor: the first row belongs to the *previous* evening only when
	// it is an overnight stay that wraps past midnight — start after noon
	// AND end-of-day hour:minute at or before the start ("23:16 – 09:08
	// sleeping"). A same-day after-noon activity ("19:27 – 20:40 dinner")
	// does not wrap and anchors to `date`. Without the wrap test, a table
	// whose first/only row is an evening activity was mis-anchored a full
	// day early, so the truth report could never find the matching state.
	// Subsequent rows advance the cursor when start time decreases below
	// the previous row's start time.
	const first = rawRows[0];
	const firstWrapsMidnight =
		first !== undefined && first.endHh * 60 + first.endMm <= first.startHh * 60 + first.startMm;
	let anchorDay = first !== undefined && first.startHh >= 12 && firstWrapsMidnight ? prevDay(date) : date;
	let prevStartMinutes = -1;

	const rows: GroundTruthRow[] = [];
	for (const r of rawRows) {
		const curStartMinutes = r.startHh * 60 + r.startMm;
		if (prevStartMinutes !== -1 && curStartMinutes < prevStartMinutes) {
			anchorDay = nextDay(anchorDay);
		}
		prevStartMinutes = curStartMinutes;

		const startTs = fitbitTsToUnix(`${anchorDay} ${pad2(r.startHh)}:${pad2(r.startMm)}:00`, tz);
		const endHhmm = r.endHh * 60 + r.endMm;
		const endDay = endHhmm <= curStartMinutes ? nextDay(anchorDay) : anchorDay;
		const endTs = fitbitTsToUnix(`${endDay} ${pad2(r.endHh)}:${pad2(r.endMm)}:00`, tz);

		if (Number.isNaN(startTs) || Number.isNaN(endTs)) continue;

		rows.push({
			windowText: r.windowText,
			startTs,
			endTs,
			blessedText: r.blessedText,
			blessed: parseBlessedCell(r.blessedText),
			status: normaliseStatus(r.statusText),
			provenance: parseProvenance(`${r.statusText} ${r.correctVersionText ?? ""}`),
			statusText: r.statusText,
			correctVersionText: r.correctVersionText,
		});
	}

	return { date, tz, rows };
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function prevDay(date: string): string {
	const [y, mo, d] = date.split("-").map(Number);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	dt.setUTCDate(dt.getUTCDate() - 1);
	return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Split a markdown table row on `|`, dropping the leading/trailing
 *  empty cells that result from `| ... |` formatting. */
function splitTableRow(line: string): string[] {
	const parts = line.split("|");
	// Drop one leading empty (from leading `|`).
	if (parts.length > 0 && parts[0].trim() === "") parts.shift();
	// Drop one trailing empty (from trailing `|`), but ONLY when the
	// original line ends with `|` — otherwise the last cell is real
	// (free-text notes that overflowed past a closing pipe).
	if (line.trimEnd().endsWith("|") && parts.length > 0 && parts[parts.length - 1].trim() === "") {
		parts.pop();
	}
	return parts;
}

function isHeaderRow(cells: readonly string[]): boolean {
	return cells[0].toLowerCase().includes("window");
}

function isSeparatorRow(cells: readonly string[]): boolean {
	return cells.every((c) => /^[\s:-]+$/.test(c));
}

function nextDay(date: string): string {
	const [y, mo, d] = date.split("-").map(Number);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	dt.setUTCDate(dt.getUTCDate() + 1);
	return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Map free-text status to one of four canonical values. Bold markers
 *  (`**wrong**`), trailing whitespace, and synonyms like "likely
 *  correct" are normalised here. */
function normaliseStatus(text: string): AuditStatus {
	// Strip bold markers AND an inline provenance tag (`{user}` etc.) — the
	// doc allows the tag in the status cell, and `parseProvenance` reads it
	// independently, so it must not defeat the verdict match here.
	const t = text
		.replace(/\*+/g, "")
		.replace(/\{[^}]*\}/g, "")
		.trim()
		.toLowerCase();
	if (t === "wrong") return "wrong";
	if (t === "correct") return "correct";
	if (t === "partial") return "partial";
	// Anything qualified ("likely correct", "likely walking", "unclear",
	// empty) is treated as unclear — we can't score against it.
	return "unclear";
}

/** Parse a blessed-cell into structured form. Returns null when the
 *  text doesn't match any known shape. */
export function parseBlessedCell(text: string): ParsedBlessed | null {
	const t = text.trim();
	if (t.length === 0) return null;

	const verb = /^(sleeping|stationary|walking|cycling|driving|bus|train|plane)\b\s*(.*)$/.exec(t);
	if (!verb) return null;
	const mode = verb[1] as GroundTruthMode;
	const rest = verb[2].trim();

	if (mode === "train" || mode === "bus") {
		// Transit leg: "From → To" or "From → To · Line/Route". `trainFromTo`
		// + `lineName` carry the board/alight + the line (train) or route
		// number (bus, e.g. "38") symmetrically.
		const tm = /^(.+?)\s+→\s+([^·]+?)(?:\s*·\s*(.+))?$/.exec(rest);
		if (tm) {
			return {
				mode,
				place: null,
				wayName: null,
				placeQualifier: null,
				trainFromTo: { from: tm[1].trim(), to: tm[2].trim() },
				lineName: tm[3]?.trim() ?? null,
			};
		}
		return {
			mode,
			place: null,
			wayName: null,
			placeQualifier: null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "@ Place [(qualifier)]" → focus-place attribution.
	const placeMatch = /^@\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(rest);
	if (placeMatch) {
		return {
			mode,
			place: placeMatch[1].trim(),
			wayName: null,
			placeQualifier: placeMatch[2]?.trim() ?? null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "on Way [(qualifier)]" → OSM-way attribution (weaker signal).
	const wayMatch = /^on\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(rest);
	if (wayMatch) {
		return {
			mode,
			place: null,
			wayName: wayMatch[1].trim(),
			placeQualifier: wayMatch[2]?.trim() ?? null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "(qualifier)" only (e.g. "stationary (unlabelled sliver)") —
	// the sliver case from the narrative; surface the qualifier but
	// leave place/way null.
	const qualOnly = /^\(([^)]+)\)$/.exec(rest);
	if (qualOnly) {
		return {
			mode,
			place: null,
			wayName: null,
			placeQualifier: qualOnly[1].trim(),
			trainFromTo: null,
			lineName: null,
		};
	}

	// Plain mode with no annotation (e.g. "walking", "driving").
	return {
		mode,
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: null,
		lineName: null,
	};
}
