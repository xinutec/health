/**
 * The one place the frontend writes down what a mode *is*.
 *
 * This vocabulary used to live in four separate maps — the timeline's icons, the
 * timeline's set of "moving" modes, the map's track colours, the speed chart's
 * fills and labels — and they had quietly drifted apart: the map had no colour
 * for `boat` or `unknown` and silently greyed them out, the speed chart was also
 * missing `sleeping`. Adding a mode server-side degraded three of the four to a
 * fallback without anyone noticing.
 *
 * So: one entry per mode, `Record<DayStateMode, …>` so the compiler refuses a
 * missing key, and every component reads from here. Adding a mode to the backend
 * now fails the frontend build until it is given an icon, a colour and a name —
 * which is exactly the reminder we want.
 *
 * Mirrors the backend `DayStateMode` (src/sleep/day-state.ts) = `TransportMode`
 * plus `sleeping` (from the Fitbit windows, not GPS) and `bus` (which rides on a
 * segment as `vehicleKind`, not as a mode).
 */

export type DayStateMode =
	| "sleeping"
	| "stationary"
	| "walking"
	| "cycling"
	| "driving"
	| "vehicle"
	| "bus"
	| "train"
	| "boat"
	| "plane"
	| "unknown";

export interface ModeStyle {
	/** Material Symbols glyph. */
	icon: string;
	/** Human-readable name, as a label ("Still", "In a vehicle"). */
	label: string;
	/** Verb phrase for the timeline's primary line ("Walking on Barn Rise"). */
	verb: string;
	/** Solid line colour for the map track. */
	color: string;
	/** Translucent band fill for the speed chart. */
	fill: string;
	/** Whether this is travel (a leg that can fold into a journey, and that the
	 *  map draws as a line) rather than a visit or a gap. */
	moving: boolean;
}

export const MODES: Record<DayStateMode, ModeStyle> = {
	sleeping: { icon: "bedtime", label: "Asleep", verb: "Sleeping", color: "#94a3b8", fill: "rgba(120, 120, 120, 0.2)", moving: false },
	stationary: { icon: "place", label: "Still", verb: "Stopped", color: "#94a3b8", fill: "rgba(120, 120, 120, 0.2)", moving: false },
	walking: { icon: "directions_walk", label: "Walking", verb: "Walking", color: "#22c55e", fill: "rgba(34, 197, 94, 0.25)", moving: true },
	cycling: { icon: "directions_bike", label: "Cycling", verb: "Cycling", color: "#f59e0b", fill: "rgba(59, 130, 246, 0.25)", moving: true },
	driving: { icon: "directions_car", label: "Driving", verb: "Driving", color: "#ef4444", fill: "rgba(249, 115, 22, 0.25)", moving: true },
	// A ride nobody could identify: vehicle speed, but no road matched, no street
	// name, no bus route, no rail line. Deliberately NOT a car — see
	// `resolveVehicleIdentity`. Muted, and named for the doubt it represents.
	vehicle: { icon: "commute", label: "In a vehicle", verb: "In a vehicle", color: "#a78bfa", fill: "rgba(167, 139, 250, 0.25)", moving: true },
	bus: { icon: "directions_bus", label: "Bus", verb: "On a bus", color: "#ea580c", fill: "rgba(234, 88, 12, 0.25)", moving: true },
	train: { icon: "train", label: "Train", verb: "Train", color: "#3b82f6", fill: "rgba(168, 85, 247, 0.25)", moving: true },
	boat: { icon: "directions_boat", label: "Boat", verb: "On a boat", color: "#06b6d4", fill: "rgba(6, 182, 212, 0.25)", moving: true },
	plane: { icon: "flight", label: "Plane", verb: "Flying", color: "#8b5cf6", fill: "rgba(236, 72, 153, 0.25)", moving: true },
	// No observation at all — a GPS gap, not a leg. Breaks a run of travel
	// rather than joining it, so `moving` is false.
	unknown: { icon: "signal_disconnected", label: "No GPS signal", verb: "No GPS signal", color: "#94a3b8", fill: "rgba(120, 120, 120, 0.12)", moving: false },
};

const FALLBACK: ModeStyle = MODES.unknown;

/** Look up a mode's style. The API is typed, but it is a network boundary — a
 *  backend that learns a new mode before this build does should degrade to the
 *  "we don't know" style rather than render a blank row. */
export function modeStyle(mode: string): ModeStyle {
	return MODES[mode as DayStateMode] ?? FALLBACK;
}

/** Modes that count as travel: eligible to fold into a journey, drawn as a line
 *  on the map. Excludes visits (`stationary`/`sleeping`) and `unknown` (a gap). */
export function isMoving(mode: string): boolean {
	return modeStyle(mode).moving;
}
