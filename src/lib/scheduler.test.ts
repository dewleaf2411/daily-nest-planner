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
    expect(result.conflicts).toHaveLength(0);
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
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ type: "task_overflow", itemIndex: 1 }),
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

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: "required_capacity",
        requiredMinutes: 240,
        scheduledMinutes: 180,
        missingMinutes: 60,
      }),
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
    expect(result.tomorrow).toContainEqual(
      expect.objectContaining({
        itemIndex: 0,
        remainingMinutes: 45,
        dueLabel: "Due today",
        reason: "Couldn't fit today",
      }),
    );
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ type: "due_today_unfit", itemIndex: 0, remainingMinutes: 45 }),
    );
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ type: "required_capacity", missingMinutes: 45 }),
    );
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
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ type: "task_overflow", itemIndex: 0, remainingMinutes: 30 }),
    );
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

  it("returns validated capacity and fixed-displacement conflicts with the final plan", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Write lab report",
        durationMinutes: 120,
        priority: "high",
        dueDate: "2026-07-17",
        dueLabel: "Due today",
        dueCategory: "today",
      }),
      task({
        originalIndex: 1,
        title: "Email teacher",
        durationMinutes: 80,
        priority: "high",
        dueDate: "2026-07-17",
        dueLabel: "Due today",
        dueCategory: "today",
      }),
      task({
        originalIndex: 2,
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
      nowMinutes: 17 * 60,
      cutoffMinutes: 22 * 60,
    });
    const emailScheduled = result.schedule
      .filter((entry) => entry.itemIndex === 1)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);

    expect(items[1].dueDate).toBe("2026-07-17");
    expect(emailScheduled).toBe(60);
    expect(result.tomorrow.some((entry) => entry.itemIndex === 1)).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: "due_today_unfit",
        itemIndex: 1,
        remainingMinutes: 20,
      }),
    );
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: "fixed_displacement",
        fixedItemIndexes: [2],
        affectedItemIndexes: [1],
        blockedMinutes: 120,
      }),
    );
  });

  it("detects an exact fixed overlap and blocks flexible work across the union", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Flexible task",
        durationMinutes: 180,
        priority: "high",
        dueDate: "2026-07-17",
        dueLabel: "Due today",
        dueCategory: "today",
      }),
      task({
        originalIndex: 1,
        title: "AI Class",
        durationMinutes: 150,
        priority: "high",
        isFixed: true,
        fixedStart: "16:30",
        fixedEnd: "19:00",
      }),
      task({
        originalIndex: 2,
        title: "Orchestra Practice",
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
      nowMinutes: 16 * 60,
      cutoffMinutes: 22 * 60,
    });
    const flexibleBlocks = result.schedule.filter((entry) => entry.itemIndex === 0);

    expect(result.conflicts[0]).toEqual({
      type: "fixed_overlap",
      firstItemIndex: 1,
      secondItemIndex: 2,
      overlapStartMinutes: 18 * 60 + 15,
      overlapEndMinutes: 19 * 60,
    });
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ type: "fixed_displacement", blockedMinutes: 225 }),
    );
    expect(result.schedule.find((entry) => entry.itemIndex === 1)).toEqual(
      expect.objectContaining({ startMinutes: 16 * 60 + 30, endMinutes: 19 * 60 }),
    );
    expect(result.schedule.find((entry) => entry.itemIndex === 2)).toEqual(
      expect.objectContaining({ startMinutes: 18 * 60 + 15, endMinutes: 20 * 60 + 15 }),
    );
    expect(
      result.schedule
        .filter((entry) => entry.kind !== "fixed")
        .every(
        (entry) => entry.endMinutes <= 16 * 60 + 30 || entry.startMinutes >= 20 * 60 + 15,
      ),
    ).toBe(true);

    const editedItems = items.map((item) =>
      item.originalIndex === 1
        ? { ...item, fixedEnd: "18:00", durationMinutes: 90 }
        : item,
    );
    const rebuilt = buildSchedule({
      items: editedItems,
      order: computeOrder(editedItems, []),
      nowMinutes: 16 * 60,
      cutoffMinutes: 22 * 60,
    });
    expect(rebuilt.conflicts.some((conflict) => conflict.type === "fixed_overlap")).toBe(false);
  });
});

describe("break scheduling", () => {
  it("keeps an explicit break out of task and fixed-commitment metadata", () => {
    const items = [
      task({ originalIndex: 0, durationMinutes: 60 }),
      task({
        originalIndex: 1,
        itemType: "break",
        title: "Tea break",
        durationMinutes: 15,
        reason: "Manual break",
        fixedStart: "10:30",
      }),
    ];

    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 10 * 60,
      cutoffMinutes: 12 * 60,
    });
    const breakEntry = result.schedule.find((entry) => entry.itemIndex === 1);

    expect(breakEntry).toEqual(
      expect.objectContaining({
        kind: "break",
        title: "Tea break",
        startMinutes: 10 * 60 + 30,
        endMinutes: 10 * 60 + 45,
      }),
    );
    expect(breakEntry?.priority).toBeUndefined();
    expect(breakEntry?.isFixed).toBeUndefined();
    expect(result.tomorrow.some((entry) => entry.itemIndex === 1)).toBe(false);
    expect(result.conflicts.some((conflict) => conflict.type === "fixed_overlap")).toBe(false);
  });

  it("recalculates later timestamps when a generated focus break is removed", () => {
    const items = [task({ durationMinutes: 60, focusBlockMinutes: 30 })];
    const base = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 10 * 60,
      cutoffMinutes: 12 * 60,
    });
    const rebuilt = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 10 * 60,
      cutoffMinutes: 12 * 60,
      suppressedBreakIds: ["br-0-1"],
    });

    expect(base.schedule.find((entry) => entry.id === "t-0-b2")?.startMinutes).toBe(10 * 60 + 35);
    expect(rebuilt.schedule.find((entry) => entry.id === "t-0-b2")?.startMinutes).toBe(10 * 60 + 30);
    expect(rebuilt.schedule.some((entry) => entry.id === "br-0-1")).toBe(false);
  });

  it("emits only one break for a duplicated timestamp slot", () => {
    const items = [
      task({
        originalIndex: 1,
        itemType: "break",
        title: "First break",
        durationMinutes: 15,
        fixedStart: "10:30",
      }),
      task({
        originalIndex: 2,
        itemType: "break",
        title: "Duplicate break",
        durationMinutes: 15,
        fixedStart: "10:30",
      }),
    ];
    const result = buildSchedule({
      items,
      order: computeOrder(items, []),
      nowMinutes: 10 * 60,
      cutoffMinutes: 12 * 60,
    });

    expect(
      result.schedule.filter(
        (entry) =>
          entry.kind === "break" &&
          entry.startMinutes === 10 * 60 + 30 &&
          entry.endMinutes === 10 * 60 + 45,
      ),
    ).toHaveLength(1);
  });
});
