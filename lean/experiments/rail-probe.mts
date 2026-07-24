import { parseRailWayName } from "../../src/geo/rail-snap.js";
for (const s of ["A → B", "A → B · L", "A → B → C", "A · X → B", " → B", "A → ", "A→B", "A → B ·  ", "  A  →  B  · L "]) {
  const r = parseRailWayName(s);
  console.log(`${JSON.stringify(s)}: ${r === null ? "null" : JSON.stringify(r)}`);
}
