import { describe, expect, it } from "vitest";
import { conflictPresentationKey } from "./conflict-flow";
import { buildSchedule, computeOrder } from "./scheduler";
import type { PlanItem, SchedulingConflict } from "./planner.types";

describe("conflict presentation identity", () => {
  it("is empty when there is no conflict to present", () => {
    expect(conflictPresentationKey([])).toBe("");
  });

  it("stays stable for the same fixed-time overlap", () => {
    const conflicts: SchedulingConflict[] = [
      {
        type: "fixed_overlap",
        firstItemIndex: 1,
        secondItemIndex: 2,
        overlapStartMinutes: 10 * 60 + 30,
        overlapEndMinutes: 11 * 60,
      },
    ];
    expect(conflictPresentationKey(conflicts)).toBe(conflictPresentationKey(conflicts));
  });

  it("changes when the overlap needing attention changes", () => {
    const first: SchedulingConflict[] = [
      {
        type: "fixed_overlap",
        firstItemIndex: 1,
        secondItemIndex: 2,
        overlapStartMinutes: 10 * 60 + 30,
        overlapEndMinutes: 11 * 60,
      },
    ];
    const next: SchedulingConflict[] = [
      {
        type: "fixed_overlap",
        firstItemIndex: 2,
        secondItemIndex: 3,
        overlapStartMinutes: 13 * 60,
        overlapEndMinutes: 13 * 60 + 30,
      },
    ];
    expect(conflictPresentationKey(next)).not.toBe(conflictPresentationKey(first));
  });

  it("keeps an overlapping fixed-commitment conflict connected to the presentation flow", () => {
    const fixed = (
      originalIndex: number,
      title: string,
      fixedStart: string,
      fixedEnd: string,
    ): PlanItem => ({
      originalIndex,
      title,
      durationMinutes: 60,
      priority: "high",
      requiredToday: false,
      reason: "Fixed commitment",
      dueDate: null,
      dueLabel: null,
      dueCategory: "none",
      suggestedDay: "today",
      isFixed: true,
      fixedStart,
      fixedEnd,
      focusBlockMinutes: null,
      note: null,
    });
    const items = [fixed(1, "Class", "10:00", "11:00"), fixed(2, "Appointment", "10:30", "11:30")];
    const firstBuild = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 9 * 60,
      cutoffMinutes: 12 * 60,
    });
    const rebuilt = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 9 * 60,
      cutoffMinutes: 12 * 60,
    });

    expect(firstBuild.conflicts).toContainEqual(
      expect.objectContaining({ type: "fixed_overlap", firstItemIndex: 1, secondItemIndex: 2 }),
    );
    expect(conflictPresentationKey(firstBuild.conflicts)).not.toBe("");
    expect(conflictPresentationKey(rebuilt.conflicts)).toBe(
      conflictPresentationKey(firstBuild.conflicts),
    );
  });
});
