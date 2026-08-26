import { describe, expect, it } from "vitest";
import type { PlanItem, ScheduleEntry } from "./planner.types";
import { getSameDayBreakInsertionStart } from "./reorder";
import { buildSchedule, computeOrder } from "./scheduler";
import { moveTaskToDay } from "./task-move";

function task(overrides: Partial<PlanItem>): PlanItem {
  return {
    originalIndex: 0,
    title: "Task",
    durationMinutes: 10,
    priority: "medium",
    requiredToday: false,
    reason: "Regression test",
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

const nowMinutes = 9 * 60;
const cutoffMinutes = nowMinutes + 25;

function duration(entries: ScheduleEntry[], tasksOnly = false): number {
  return entries
    .filter((entry) => !tasksOnly || entry.kind === "task")
    .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);
}

function reorderedSchedule() {
  const items = [
    task({ originalIndex: 10, title: "Gym" }),
    task({
      originalIndex: 20,
      itemType: "break",
      title: "Break",
      durationMinutes: 5,
      fixedStart: "09:10",
    }),
    task({ originalIndex: 30, title: "Eat" }),
  ];
  const userOrder = [10, 30];
  const before = buildSchedule({
    items,
    order: computeOrder(items, userOrder),
    nowMinutes,
    cutoffMinutes,
  });
  const breakStart = getSameDayBreakInsertionStart({
    items,
    userOrder,
    sourceEntryId: "break-20",
    sourceItemIndex: 20,
    beforeEntryId: null,
    beforeTaskId: null,
    nowMinutes,
    cutoffMinutes,
  });
  const movedItems = items.map((item) =>
    item.originalIndex === 20 ? { ...item, fixedStart: "09:20" } : item,
  );
  const after = buildSchedule({
    items: movedItems,
    order: computeOrder(movedItems, userOrder),
    nowMinutes,
    cutoffMinutes,
  });
  return { items, movedItems, before, after, breakStart };
}

describe("same-day schedule reordering", () => {
  it("reorders Gym, Eat, and Break without an insufficient-time result", () => {
    const { after, breakStart } = reorderedSchedule();
    expect(breakStart).toBe(9 * 60 + 20);
    expect(after.schedule.map((entry) => entry.title)).toEqual(["Gym", "Eat", "Break"]);
    expect(duration(after.schedule, true)).toBe(20);
    expect(after.tomorrow).toHaveLength(0);
    expect(after.conflicts).toHaveLength(0);
  });

  it("moves a break from between two tasks to after them", () => {
    const { before, after } = reorderedSchedule();
    expect(before.schedule.map((entry) => entry.title)).toEqual(["Gym", "Break", "Eat"]);
    expect(after.schedule.map((entry) => entry.title)).toEqual(["Gym", "Eat", "Break"]);
  });

  it("moves an existing 30-minute break without asking for 30 more minutes", () => {
    const items = [
      task({ originalIndex: 10, title: "Gym" }),
      task({
        originalIndex: 20,
        itemType: "break",
        title: "Break",
        durationMinutes: 30,
        fixedStart: "09:10",
      }),
      task({ originalIndex: 30, title: "Eat" }),
    ];
    const breakStart = getSameDayBreakInsertionStart({
      items,
      userOrder: [10, 30],
      sourceEntryId: "break-20",
      sourceItemIndex: 20,
      beforeEntryId: null,
      beforeTaskId: null,
      nowMinutes,
      cutoffMinutes: 9 * 60 + 50,
    });
    const movedItems = items.map((item) =>
      item.originalIndex === 20 ? { ...item, fixedStart: "09:20" } : item,
    );
    const result = buildSchedule({
      items: movedItems,
      order: computeOrder(movedItems, [10, 30]),
      nowMinutes,
      cutoffMinutes: 9 * 60 + 50,
    });

    expect(breakStart).toBe(9 * 60 + 20);
    expect(result.schedule.map((entry) => entry.title)).toEqual(["Gym", "Eat", "Break"]);
    expect(duration(result.schedule)).toBe(50);
    expect(result.tomorrow).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("preserves every block ID and exact duration", () => {
    const { items, movedItems, before, after } = reorderedSchedule();
    const signatures = (entries: ScheduleEntry[]) =>
      entries
        .map((entry) => ({ id: entry.id, minutes: entry.endMinutes - entry.startMinutes }))
        .sort((first, second) => first.id.localeCompare(second.id));
    expect(movedItems.map((item) => item.originalIndex)).toEqual(
      items.map((item) => item.originalIndex),
    );
    expect(movedItems.map((item) => item.durationMinutes)).toEqual(
      items.map((item) => item.durationMinutes),
    );
    expect(signatures(after.schedule)).toEqual(signatures(before.schedule));
  });

  it("keeps total scheduled duration unchanged", () => {
    const { before, after } = reorderedSchedule();
    expect(duration(before.schedule)).toBe(25);
    expect(duration(after.schedule)).toBe(duration(before.schedule));
  });

  it("still reports a genuine fixed-time collision", () => {
    const items = [
      task({ originalIndex: 10, title: "Gym" }),
      task({
        originalIndex: 20,
        itemType: "break",
        title: "Break",
        durationMinutes: 5,
        fixedStart: "09:10",
      }),
      task({
        originalIndex: 30,
        title: "Appointment",
        isFixed: true,
        fixedStart: "09:20",
        fixedEnd: "09:30",
      }),
    ];
    const collisionStart = getSameDayBreakInsertionStart({
      items,
      userOrder: [10],
      sourceEntryId: "break-20",
      sourceItemIndex: 20,
      beforeEntryId: "fixed-30",
      beforeTaskId: null,
      nowMinutes,
      cutoffMinutes: 9 * 60 + 30,
    });
    const movedItems = items.map((item) =>
      item.originalIndex === 20 ? { ...item, fixedStart: "09:20" } : item,
    );
    const result = buildSchedule({
      items: movedItems,
      order: computeOrder(movedItems, [10]),
      nowMinutes,
      cutoffMinutes: 9 * 60 + 30,
    });
    expect(collisionStart).toBe(9 * 60 + 20);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: "break_overlap",
        breakItemIndex: 20,
        otherItemIndex: 30,
      }),
    );
  });

  it("does not change canonical Today and Tomorrow movement", () => {
    const initial = {
      items: [task({ originalIndex: 10, title: "Gym" })],
      userOrder: [10],
    };
    const tomorrow = moveTaskToDay(initial, 10, "tomorrow");
    const today = moveTaskToDay(tomorrow, 10, "today");
    expect(tomorrow.items[0]).toEqual(
      expect.objectContaining({ originalIndex: 10, durationMinutes: 10, suggestedDay: "tomorrow" }),
    );
    expect(today.items[0]).toEqual(
      expect.objectContaining({ originalIndex: 10, durationMinutes: 10, suggestedDay: "today" }),
    );
    expect(today.userOrder).toEqual([10]);
  });

  it("does not count an existing generated break again when it moves later", () => {
    const items = [
      task({ originalIndex: 10, title: "Gym" }),
      task({
        originalIndex: 20,
        title: "Fixed commitment",
        isFixed: true,
        fixedStart: "09:40",
        fixedEnd: "09:50",
      }),
    ];
    const baseline = buildSchedule({
      items,
      order: computeOrder(items, [10]),
      nowMinutes,
      cutoffMinutes: 9 * 60 + 50,
    });
    const generatedBreak = baseline.schedule.find(
      (entry) => entry.id === "gap-550-580",
    );

    expect(generatedBreak).toEqual(
      expect.objectContaining({
        kind: "break",
        startMinutes: 9 * 60 + 10,
        endMinutes: 9 * 60 + 40,
      }),
    );
    expect(
      getSameDayBreakInsertionStart({
        items,
        userOrder: [10],
        sourceEntryId: generatedBreak!.id,
        sourceItemIndex: -1,
        beforeEntryId: "fixed-20",
        beforeTaskId: null,
        nowMinutes,
        cutoffMinutes: 9 * 60 + 50,
      }),
    ).toBe(9 * 60 + 10);
  });
});
