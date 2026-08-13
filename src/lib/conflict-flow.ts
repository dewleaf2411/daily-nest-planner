import type { SchedulingConflict } from "./planner.types";

/** Stable identity for the conflict set currently needing user attention. */
export function conflictPresentationKey(conflicts: readonly SchedulingConflict[]): string {
  if (conflicts.length === 0) return "";
  return JSON.stringify(conflicts);
}
