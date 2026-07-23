import { describe, expect, it } from "vitest";
import { applyPlanningRules, getPlanningWindow } from "./planner.logic";
import { deterministicFallback } from "./planner.functions";
import { buildSchedule, computeOrder } from "./scheduler";
import type { PlanItem } from "./planner.types";

function task(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    originalIndex: 0,
    title: "Task",
    durationMinutes: 60,
    priority: "low",
    requiredToday: false,
    reason: "Test task.",
    dueDate: null,
    dueLabel: null,
    dueCategory: "none",
    suggestedDay: "today",
    isFixed: false,
    fixedStart: null,
    fixedEnd: null,
    focusBlockMinutes: null,
    note: null,
    ...overrides,
  };
}

describe("required-today planning", () => {
  it("calculates the exact 7 PM to 10 PM window and places a 60-minute must-finish task", () => {
    const window = getPlanningWindow("2026-07-17T19:00:00", "22:00");
    const input = "I must finish the 60-minute report today.";
    const items = applyPlanningRules(deterministicFallback(input, "2026-07-17T19:00:00"), input);
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: window.nowMinutes,
      cutoffMinutes: window.cutoffMinutes,
    });

    expect(window.availableMinutes).toBe(180);
    expect(items[0].durationMinutes).toBe(60);
    expect(items[0].requiredToday).toBe(true);
    expect(result.schedule[0]).toEqual(
      expect.objectContaining({ itemIndex: 0, startMinutes: 1140 }),
    );
    expect(
      result.schedule
        .filter((entry) => entry.itemIndex === 0)
        .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0),
    ).toBe(60);
    expect(result.requiredTodayConflict).toBeNull();
  });

  it("schedules required-today work before optional work is dropped", () => {
    const items = [
      task({ originalIndex: 0, title: "Optional reading", durationMinutes: 90 }),
      task({ originalIndex: 1, title: "Optional organizing", durationMinutes: 90 }),
      task({
        originalIndex: 2,
        title: "Submit application",
        durationMinutes: 60,
        priority: "high",
        requiredToday: true,
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, [0, 1, 2]),
      nowMinutes: 19 * 60,
      cutoffMinutes: 22 * 60,
    });

    expect(result.schedule[0]).toEqual(
      expect.objectContaining({ itemIndex: 2, startMinutes: 1140, endMinutes: 1200 }),
    );
    expect(result.attention.some((entry) => entry.itemIndex === 0 || entry.itemIndex === 1)).toBe(
      true,
    );
    expect(result.tomorrow.some((entry) => entry.itemIndex === 2)).toBe(false);
  });

  it("reports the missing time when required-today work exceeds the real window", () => {
    const items = [
      task({
        title: "Finish project",
        durationMinutes: 240,
        priority: "high",
        requiredToday: true,
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 19 * 60,
      cutoffMinutes: 22 * 60,
    });

    expect(result.requiredTodayConflict).toEqual({
      requiredMinutes: 240,
      scheduledMinutes: 180,
      missingMinutes: 60,
    });
    expect(result.attention).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 60 }),
    );
    expect(result.tomorrow).toHaveLength(0);
  });

  it("keeps a next-week due date while scheduling work on it today", () => {
    const items = deterministicFallback(
      "Work on the proposal today, due next week.",
      "2026-07-17T19:00:00",
    );
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 19 * 60,
      cutoffMinutes: 22 * 60,
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        dueDate: "2026-07-24",
        dueCategory: "future",
        suggestedDay: "today",
      }),
    );
    expect(result.schedule).toContainEqual(expect.objectContaining({ itemIndex: 0 }));
  });

  it("keeps orchestra fixed and schedules flexible work around it", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry", durationMinutes: 90, focusBlockMinutes: 45 }),
      task({
        originalIndex: 1,
        title: "Orchestra",
        durationMinutes: 120,
        priority: "high",
        isFixed: true,
        fixedStart: "18:15",
        fixedEnd: "20:15",
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 17 * 60 + 20,
      cutoffMinutes: 22 * 60,
    });

    expect(result.schedule.find((entry) => entry.itemIndex === 1)).toEqual(
      expect.objectContaining({ kind: "fixed", startMinutes: 18 * 60 + 15, endMinutes: 20 * 60 + 15 }),
    );
    expect(result.schedule.filter((entry) => entry.itemIndex === 0)).toEqual([
      expect.objectContaining({ startMinutes: 17 * 60 + 20, endMinutes: 18 * 60 + 5, blockNumber: 1, totalBlocks: 2 }),
      expect.objectContaining({ startMinutes: 20 * 60 + 15, endMinutes: 21 * 60, blockNumber: 2, totalBlocks: 2 }),
    ]);
  });

  it("marks a due-today email that cannot fit as needing attention without changing its due date", () => {
    const items = [
      task({
        title: "Send email",
        durationMinutes: 45,
        priority: "high",
        dueDate: "2026-07-17",
        dueLabel: "Due today",
        dueCategory: "today",
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 22 * 60,
      cutoffMinutes: 22 * 60,
    });

    expect(items[0].dueDate).toBe("2026-07-17");
    expect(result.attention).toEqual([
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 45 }),
    ]);
    expect(result.tomorrow).toHaveLength(0);
    expect(result.requiredTodayConflict).toEqual({
      requiredMinutes: 45,
      scheduledMinutes: 0,
      missingMinutes: 45,
    });
  });

  it("never lists a partially scheduled task in both Today and Tomorrow", () => {
    const items = [task({ title: "Read chapter", durationMinutes: 60 })];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 21 * 60 + 30,
      cutoffMinutes: 22 * 60,
    });

    expect(result.schedule.some((entry) => entry.itemIndex === 0)).toBe(true);
    expect(result.attention).toContainEqual(expect.objectContaining({ itemIndex: 0, remainingMinutes: 30 }));
    expect(result.tomorrow.some((entry) => entry.itemIndex === 0)).toBe(false);
  });

  it("makes the scheduled total equal every visible task, fixed commitment, and break block", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry", durationMinutes: 90, focusBlockMinutes: 45 }),
      task({
        originalIndex: 1,
        title: "Orchestra",
        durationMinutes: 120,
        priority: "high",
        isFixed: true,
        fixedStart: "18:15",
        fixedEnd: "20:15",
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 17 * 60 + 20,
      cutoffMinutes: 22 * 60,
    });
    const visibleMinutes = result.schedule.reduce(
      (total, entry) => total + entry.endMinutes - entry.startMinutes,
      0,
    );

    expect(result.schedule.some((entry) => entry.kind === "break")).toBe(true);
    expect(result.scheduledMinutes).toBe(visibleMinutes);
    expect(result.scheduledMinutes).toBe(215);
  });
});
