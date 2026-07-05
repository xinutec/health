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

export function formatDay(date: string): string {
  return new Date(date).toLocaleDateString("en", { month: "short", day: "numeric" });
}
