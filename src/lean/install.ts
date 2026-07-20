/**
 * Install the verified-core pass hooks into the pure map-match core.
 *
 * `map-match-core.ts` is import-free by design (the deterministic fixture
 * core), so it cannot reach the Lean bridge itself; it exposes injection
 * points instead. This module — a non-pure layer that may pull in the bridge
 * — wires those hooks to the `lean-passes` wrappers.
 *
 * The wrapper is a no-op when `LEAN_PASSES` is unset (`simplifyViaLean`
 * returns the TS result before any bridge call), so installing the hook keeps
 * the pipeline byte-identical by default; it only diverges to shadow/serve
 * when the flag is on. Idempotent — the first call wins.
 */

import { setSimplifyHook } from "../geo/map-match-core.js";
import { simplifyViaLean } from "./lean-passes.js";

let installed = false;

export function installLeanPasses(): void {
	if (installed) return;
	installed = true;
	setSimplifyHook((pts, toleranceM, tsResult) => simplifyViaLean(pts, toleranceM, tsResult));
}
