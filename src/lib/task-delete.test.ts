import { describe, expect, it } from "vitest";
import { buildSchedule, computeOrder } from "./scheduler";
import { deleteTaskFromPlanState, type TaskPlanState } from "./task-delete";
import type { PlanItem } from "./planner.types";

function task(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    originalIndex: 0,
    title: "Task",
    durationMinutes: 60,
    priority: "medium",
    requiredToday: false,
    reason: "Test task",
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

function state(items: PlanItem[]): TaskPlanState {
  return {
    items,
    userOrder: items.map((item) => item.originalIndex),
    completedTasks: new Set(items.map((item) => item.originalIndex)),
    splitMinutes: Object.fromEntries(items.map((item) => [item.originalIndex, 15])),
  };
}

function visibleIndexes(items: PlanItem[]) {
  const result = buildSchedule({
    items,
    order: computeOrder(items, []),
    nowMinutes: 9 * 60,
    cutoffMinutes: 17 * 60,
  });
  return {
    today: result.schedule.map((entry) => entry.itemIndex),
    tomorrow: result.tomorrow.map((entry) => entry.itemIndex),
  };
}

describe("delete task", () => {
  it("deletes a task scheduled only today", () => {
    const result = deleteTaskFromPlanState(state([task()]), 0);

    expect(result.items).toHaveLength(0);
    expect(visibleIndexes(result.items)).toEqual({ today: [], tomorrow: [] });
  });

  it("deletes a task scheduled only tomorrow", () => {
    const result = deleteTaskFromPlanState(
      state([task({ suggestedDay: "tomorrow", deferredByUser: true })]),
      0,
    );

    expect(result.items).toHaveLength(0);
    expect(visibleIndexes(result.items)).toEqual({ today: [], tomorrow: [] });
  });

  it("deletes a task split between today and tomorrow, including its linked continuation", () => {
    const splitTask = task({
      todayDurationMinutes: 30,
      remainingDurationMinutes: 30,
    });
    const continuation: PlanItem & { parentTaskIndex: number } = {
      ...task({
        originalIndex: 2,
        durationMinutes: 15,
        suggestedDay: "tomorrow",
        reason: "Split from today",
      }),
      parentTaskIndex: 0,
    };
    const before = visibleIndexes([splitTask, continuation]);

    expect(before.today).toContain(0);
    expect(before.tomorrow).toEqual(expect.arrayContaining([0, 2]));

    const result = deleteTaskFromPlanState(state([splitTask, continuation]), 0);
    expect(result.items).toHaveLength(0);
    expect(visibleIndexes(result.items)).toEqual({ today: [], tomorrow: [] });
  });

  it("deletes a task that was previously shortened", () => {
    const shortened = task({
      durationMinutes: 90,
      todayDurationMinutes: 40,
      remainingDurationMinutes: 50,
    });
    const result = deleteTaskFromPlanState(state([shortened]), 0);

    expect(result.items).toHaveLength(0);
    expect(result.userOrder).toHaveLength(0);
    expect(result.completedTasks.size).toBe(0);
    expect(result.splitMinutes).toEqual({});
  });

  it("changes nothing when deletion is cancelled", () => {
    const original = state([task()]);
    const result = deleteTaskFromPlanState(original, null);

    expect(result).toBe(original);
    expect(result.items).toEqual([expect.objectContaining({ originalIndex: 0 })]);
  });

  it("deleting one task does not remove any other task or a fixed commitment", () => {
    const other = task({ originalIndex: 1, title: "Task" });
    const fixed = task({
      originalIndex: 2,
      title: "AI Class",
      isFixed: true,
      fixedStart: "13:00",
      fixedEnd: "14:00",
    });
    const result = deleteTaskFromPlanState(state([task(), other, fixed]), 0);

    expect(result.items.map((item) => item.originalIndex)).toEqual([1, 2]);
    const rebuilt = buildSchedule({
      items: result.items,
      order: computeOrder(result.items, []),
      nowMinutes: 9 * 60,
      cutoffMinutes: 17 * 60,
    });
    expect(rebuilt.schedule.map((entry) => entry.itemIndex)).toEqual(
      expect.arrayContaining([1, 2]),
    );
    expect(rebuilt.schedule.find((entry) => entry.itemIndex === 1)?.startMinutes).toBe(9 * 60);
  });
});
