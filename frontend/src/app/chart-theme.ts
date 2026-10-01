// Shared Chart.js styling constants for the dark theme
export const chartColors = {
  primary: "#7c3aed",
  red: "#ef4444",
  blue: "#3b82f6",
  deepBlue: "#1e3a5f",
  purple: "#8b5cf6",
  amber: "#f59e0b",
  green: "#22c55e",
} as const;

export const gridColor = "rgba(255, 255, 255, 0.06)";
export const tickColor = "rgba(255, 255, 255, 0.5)";

/** The reader's calendar day of an instant, `YYYY-MM-DD` from local fields.
 *  Not `toISOString().slice(0, 10)`: that is the UTC day, a day behind between
 *  midnight and 01:00 BST, so "today" and a late weigh-in landed on the wrong day. */
export function localDay(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDay(date: string): string {
  return new Date(date).toLocaleDateString("en", { month: "short", day: "numeric" });
}
