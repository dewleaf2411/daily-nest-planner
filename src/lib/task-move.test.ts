import { describe, expect, it } from "vitest";
import { buildSchedule, computeOrder } from "./scheduler";
import { moveTaskToDay, type TaskMoveState } from "./task-move";
import type { PlanItem, ScheduleEntry } from "./planner.types";

function task(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    originalIndex: 0,
    title: "Write report",
    durationMinutes: 60,
    priority: "medium",
    requiredToday: false,
    reason: "Important work",
    dueDate: "2026-08-13",
    dueLabel: "Due tomorrow",
    dueCategory: "tomorrow",
    suggestedDay: "today",
    isFixed: false,
    fixedStart: null,
    fixedEnd: null,
    focusBlockMinutes: null,
    note: null,
    ...overrides,
  };
}

function schedule(state: TaskMoveState, nowMinutes = 9 * 60, cutoffMinutes = 17 * 60) {
  return buildSchedule({
    items: state.items,
    order: computeOrder(state.items, state.userOrder),
    nowMinutes,
    cutoffMinutes,
  });
}

function occurrences(state: TaskMoveState, taskIndex: number) {
  const result = schedule(state);
  return {
    today: new Set(
      result.schedule
        .filter((entry) => entry.kind === "task" && entry.itemIndex === taskIndex)
        .map((entry) => entry.itemIndex),
    ).size,
    tomorrow: result.tomorrow.filter((entry) => entry.itemIndex === taskIndex).length,
  };
}

function expectNoOverlaps(entries: ScheduleEntry[]) {
  const blocks = [...entries].sort(
    (first, second) =>
      first.startMinutes - second.startMinutes || first.endMinutes - second.endMinutes,
  );
  for (let index = 1; index < blocks.length; index += 1) {
    expect(blocks[index].startMinutes).toBeGreaterThanOrEqual(blocks[index - 1].endMinutes);
  }
}

describe("task day moves", () => {
  it("moves Today -> Tomorrow -> Today exactly once", () => {
    const initial = { items: [task()], userOrder: [0] };
    const tomorrow = moveTaskToDay(initial, 0, "tomorrow");
    expect(occurrences(tomorrow, 0)).toEqual({ today: 0, tomorrow: 1 });

    const today = moveTaskToDay(tomorrow, 0, "today");
    expect(occurrences(today, 0)).toEqual({ today: 1, tomorrow: 0 });
    expect(today.userOrder).toEqual([0]);
  });

  it("moves Tomorrow -> Today -> Tomorrow exactly once", () => {
    const initial = { items: [task({ suggestedDay: "tomorrow" })], userOrder: [] };
    const today = moveTaskToDay(initial, 0, "today");
    expect(occurrences(today, 0)).toEqual({ today: 1, tomorrow: 0 });

    const tomorrow = moveTaskToDay(today, 0, "tomorrow");
    expect(occurrences(tomorrow, 0)).toEqual({ today: 0, tomorrow: 1 });
  });

  it("remains stable when moved back and forth repeatedly", () => {
    let state = { items: [task()], userOrder: [0, 0, 0] };
    for (let count = 0; count < 8; count += 1) {
      const day = count % 2 === 0 ? "tomorrow" : "today";
      state = moveTaskToDay(state, 0, day);
      expect(state.items).toHaveLength(1);
      expect(new Set(state.userOrder).size).toBe(state.userOrder.length);
      expect(occurrences(state, 0)).toEqual(
        day === "today" ? { today: 1, tomorrow: 0 } : { today: 0, tomorrow: 1 },
      );
    }
  });

  it("preserves the due date and 60-minute duration when moving to Today", () => {
    const moved = moveTaskToDay(
      { items: [task({ suggestedDay: "tomorrow", remainingDurationMinutes: 15 })], userOrder: [] },
      0,
      "today",
    );
    const movedTask = moved.items[0];
    const result = schedule(moved);
    const scheduledMinutes = result.schedule
      .filter((entry) => entry.kind === "task" && entry.itemIndex === 0)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);

    expect(movedTask.dueDate).toBe("2026-08-13");
    expect(movedTask.dueLabel).toBe("Due tomorrow");
    expect(movedTask.durationMinutes).toBe(60);
    expect(scheduledMinutes).toBe(60);
  });

  it("moves several tasks without loss, duplication, or Today overlaps", () => {
    let state: TaskMoveState = {
      items: [
        task({ originalIndex: 0, title: "First", durationMinutes: 60 }),
        task({ originalIndex: 1, title: "Second", durationMinutes: 35, suggestedDay: "tomorrow" }),
        task({ originalIndex: 2, title: "Third", durationMinutes: 45 }),
        task({
          originalIndex: 3,
          title: "Appointment",
          durationMinutes: 60,
          suggestedDay: "today",
          isFixed: true,
          fixedStart: "11:00",
          fixedEnd: "12:00",
        }),
      ],
      userOrder: [0, 2],
    };
    state = moveTaskToDay(state, 0, "tomorrow");
    state = moveTaskToDay(state, 1, "today");
    state = moveTaskToDay(state, 2, "tomorrow");
    state = moveTaskToDay(state, 2, "today");

    const result = schedule(state);
    expect(state.items.map((item) => item.originalIndex).sort()).toEqual([0, 1, 2, 3]);
    expect(result.tomorrow.map((entry) => entry.itemIndex)).toEqual([0]);
    expect(new Set(result.tomorrow.map((entry) => entry.itemIndex)).size).toBe(
      result.tomorrow.length,
    );
    expectNoOverlaps(result.schedule);
  });

  it("keeps a legacy Tomorrow task visible even when stale remaining work is zero", () => {
    const state = {
      items: [task({ suggestedDay: "tomorrow", remainingDurationMinutes: 0 })],
      userOrder: [],
    };
    const result = schedule(state);
    expect(result.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 60 }),
    );
  });

  it("rebuilds Today timestamps from the current schedule", () => {
    const state = {
      items: [
        task({ originalIndex: 0, title: "Existing", durationMinutes: 30 }),
        task({ originalIndex: 1, title: "Moved", suggestedDay: "tomorrow" }),
      ],
      userOrder: [0],
    };
    const moved = moveTaskToDay(state, 1, "today");
    const firstBuild = schedule(moved, 9 * 60);
    const laterBuild = schedule(moved, 10 * 60);
    const firstStart = firstBuild.schedule.find((entry) => entry.itemIndex === 1)?.startMinutes;
    const laterStart = laterBuild.schedule.find((entry) => entry.itemIndex === 1)?.startMinutes;

    expect(firstStart).toBe(9 * 60 + 30);
    expect(laterStart).toBe(10 * 60 + 30);
  });

  it("keeps the existing no-room behavior after a move to Today", () => {
    const moved = moveTaskToDay(
      { items: [task({ suggestedDay: "tomorrow" })], userOrder: [] },
      0,
      "today",
    );
    const result = schedule(moved, 17 * 60, 17 * 60);

    expect(result.schedule.some((entry) => entry.itemIndex === 0)).toBe(false);
    expect(result.tomorrow).toContainEqual(
      expect.objectContaining({
        itemIndex: 0,
        remainingMinutes: 60,
        reason: "Couldn't fit today",
      }),
    );
  });
});
