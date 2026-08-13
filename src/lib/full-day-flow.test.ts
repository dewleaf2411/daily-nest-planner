import { describe, expect, it } from "vitest";
import {
  buildRoomSuggestions,
  previewRoomAdjustment,
  previewRoomAdjustments,
} from "./full-day-flow";
import type { PlanItem } from "./planner.types";
import { buildSchedule } from "./scheduler";

function task(
  overrides: Partial<PlanItem> & Pick<PlanItem, "originalIndex" | "title" | "durationMinutes">,
): PlanItem {
  return {
    priority: "medium",
    suggestedDay: "today",
    dueDate: null,
    dueCategory: "none",
    isFixed: false,
    fixedStart: null,
    fixedEnd: null,
    note: "",
    ...overrides,
    requiredToday: overrides.requiredToday ?? false,
    reason: overrides.reason ?? "Test task",
  };
}

function suggestionHasKind(
  suggestion: ReturnType<typeof buildRoomSuggestions>[number],
  kind: "move" | "shorten" | "start" | "remove" | "extend",
) {
  const adjustments = Array.isArray(suggestion.adjustment)
    ? suggestion.adjustment
    : [suggestion.adjustment];
  return adjustments.some((adjustment) => adjustment.kind === kind);
}

describe("full day make-room flow", () => {
  it("never suggests moving a fixed commitment", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Orchestra",
        durationMinutes: 120,
        isFixed: true,
        fixedStart: "18:15",
        fixedEnd: "20:15",
      }),
      task({ originalIndex: 1, title: "Flexible reading", durationMinutes: 45, priority: "low" }),
      task({ originalIndex: 2, title: "New task", durationMinutes: 45, suggestedDay: "tomorrow" }),
    ];
    const suggestions = buildRoomSuggestions({
      items,
      order: [1],
      newTaskIndex: 2,
      nowMinutes: 17 * 60,
      cutoffMinutes: 21 * 60,
    });
    expect(
      suggestions.some(
        (suggestion) =>
          "targetIndex" in suggestion.adjustment && suggestion.adjustment.targetIndex === 0,
      ),
    ).toBe(false);
  });

  it("does not suggest moving a task due sooner than the new task", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Due first",
        durationMinutes: 45,
        priority: "low",
        dueDate: "2026-07-23",
        dueCategory: "today",
      }),
      task({
        originalIndex: 1,
        title: "New task",
        durationMinutes: 45,
        suggestedDay: "tomorrow",
        dueDate: "2026-07-24",
        dueCategory: "tomorrow",
      }),
    ];
    const suggestions = buildRoomSuggestions({
      items,
      order: [0],
      newTaskIndex: 1,
      nowMinutes: 20 * 60,
      cutoffMinutes: 21 * 60,
    });
    expect(suggestions.some((suggestion) => suggestionHasKind(suggestion, "move"))).toBe(false);
  });

  it("previews changes without mutating the current plan", () => {
    const items = [
      task({ originalIndex: 0, title: "Flexible task", durationMinutes: 45, priority: "low" }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 45, suggestedDay: "tomorrow" }),
    ];
    const original = JSON.stringify(items);
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 20 * 60, cutoffMinutes: 20 * 60 + 45 },
      { kind: "move", targetIndex: 0 },
    );
    expect(preview).not.toBeNull();
    expect(JSON.stringify(items)).toBe(original);
    expect(preview?.items.find((item) => item.originalIndex === 0)?.suggestedDay).toBe("tomorrow");
    expect(preview?.items.find((item) => item.originalIndex === 1)?.suggestedDay).toBe("today");
  });

  it("can preview a short start while leaving the remainder tomorrow", () => {
    const items = [
      task({ originalIndex: 0, title: "New task", durationMinutes: 45, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [], newTaskIndex: 0, nowMinutes: 20 * 60, cutoffMinutes: 20 * 60 + 15 },
      { kind: "start", sessionMinutes: 15 },
    );
    expect(preview).not.toBeNull();
    expect(preview?.items.find((item) => item.originalIndex === 0)?.durationMinutes).toBe(45);
    expect(preview?.items.find((item) => item.originalIndex === 0)?.todayDurationMinutes).toBe(15);
    expect(preview?.items.find((item) => item.originalIndex === 0)?.remainingDurationMinutes).toBe(
      30,
    );
    expect(preview?.result.schedule).toHaveLength(1);
    expect(preview?.result.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 30 }),
    );
  });

  it("shortens a 60-minute selected task to 45 today and carries 15 to Tomorrow", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Selected task",
        durationMinutes: 60,
        suggestedDay: "tomorrow",
        dueDate: "2026-08-13",
        dueCategory: "tomorrow",
        dueLabel: "Due tomorrow",
      }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [], newTaskIndex: 0, nowMinutes: 18 * 60, cutoffMinutes: 18 * 60 + 45 },
      { kind: "start", sessionMinutes: 45 },
    );
    const selectedTask = preview?.items.find((item) => item.originalIndex === 0);
    const todayMinutes = preview?.result.schedule
      .filter((entry) => entry.itemIndex === 0)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);
    const tomorrowMinutes = preview?.result.tomorrow.find(
      (entry) => entry.itemIndex === 0,
    )?.remainingMinutes;

    expect(todayMinutes).toBe(45);
    expect(tomorrowMinutes).toBe(15);
    expect((todayMinutes ?? 0) + (tomorrowMinutes ?? 0)).toBe(60);
    expect(selectedTask?.durationMinutes).toBe(60);
    expect(selectedTask?.dueDate).toBe("2026-08-13");
    expect(preview?.items.filter((item) => item.originalIndex === 0)).toHaveLength(1);
  });

  it("adds 15 available minutes without overlaps and preserves the remaining work", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Appointment",
        durationMinutes: 60,
        isFixed: true,
        fixedStart: "18:00",
        fixedEnd: "19:00",
      }),
      task({
        originalIndex: 1,
        title: "Selected task",
        durationMinutes: 60,
        suggestedDay: "tomorrow",
        dueDate: "2026-08-13",
        dueCategory: "tomorrow",
      }),
    ];
    const preview = previewRoomAdjustments(
      { items, order: [], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      [
        { kind: "extend", minutes: 15 },
        { kind: "start", sessionMinutes: 15 },
      ],
    );
    const blocks = [...(preview?.result.schedule ?? [])].sort(
      (first, second) => first.startMinutes - second.startMinutes,
    );
    const todayMinutes = blocks
      .filter((entry) => entry.itemIndex === 1)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);
    const tomorrowMinutes = preview?.result.tomorrow.find(
      (entry) => entry.itemIndex === 1,
    )?.remainingMinutes;

    expect(preview?.cutoffMinutes).toBe(19 * 60 + 15);
    expect(preview?.enoughRoom).toBe(true);
    expect(todayMinutes).toBe(15);
    expect(tomorrowMinutes).toBe(45);
    expect(todayMinutes + (tomorrowMinutes ?? 0)).toBe(60);
    expect(preview?.items.find((item) => item.originalIndex === 1)?.dueDate).toBe("2026-08-13");
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index].startMinutes).toBeGreaterThanOrEqual(blocks[index - 1].endMinutes);
    }
  });

  it("moving a 90-minute task creates enough room", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry worksheet", durationMinutes: 90 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 60, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 20 * 60 },
      { kind: "move", targetIndex: 0 },
    );

    expect(preview?.minutesFreed).toBe(90);
    expect(preview?.missingMinutes).toBe(0);
    expect(preview?.enoughRoom).toBe(true);
    expect(preview?.items.find((item) => item.originalIndex === 0)?.suggestedDay).toBe("tomorrow");
  });

  it("shortening a 90-minute task to 40 minutes frees exactly 50 minutes", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry worksheet", durationMinutes: 90 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 50, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 20 * 60 },
      { kind: "shorten", targetIndex: 0, keepMinutes: 40 },
    );

    expect(preview?.affectedCurrentMinutes).toBe(90);
    expect(preview?.affectedAfterMinutes).toBe(40);
    expect(preview?.minutesFreed).toBe(50);
    expect(preview?.enoughRoom).toBe(true);
  });

  it("rejects fractional minutes when shortening a task", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry worksheet", durationMinutes: 60 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 20, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      { kind: "shorten", targetIndex: 0, keepMinutes: 40.5 },
    );

    expect(preview).toBeNull();
  });

  it("previews an insufficient removal and keeps the task out of Tomorrow", () => {
    const items = [
      task({ originalIndex: 0, title: "Short task", durationMinutes: 20 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 35, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 20 * 60, cutoffMinutes: 20 * 60 + 20 },
      { kind: "remove", targetIndex: 0 },
    );

    expect(preview).not.toBeNull();
    expect(preview?.minutesFreed).toBe(20);
    expect(preview?.newTaskNeededMinutes).toBe(35);
    expect(preview?.missingMinutes).toBe(15);
    expect(preview?.enoughRoom).toBe(false);
    expect(preview?.items.find((item) => item.originalIndex === 0)?.removedFromPlan).toBe(true);
    expect(preview?.result.tomorrow.some((item) => item.itemIndex === 0)).toBe(false);
  });

  it("leaves 45 minutes over when a 60-minute removal makes room for 15 minutes", () => {
    const items = [
      task({ originalIndex: 0, title: "Long task", durationMinutes: 60 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      { kind: "remove", targetIndex: 0 },
    );

    expect(preview?.minutesFreed).toBe(60);
    expect(preview?.newTaskNeededMinutes).toBe(15);
    expect(preview?.missingMinutes).toBe(0);
    expect(preview?.minutesLeftOver).toBe(45);
    expect(preview?.enoughRoom).toBe(true);
  });

  it("shortens 60 minutes to 45 to create exactly 15 minutes", () => {
    const items = [
      task({ originalIndex: 0, title: "Chemistry worksheet", durationMinutes: 60 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      { kind: "shorten", targetIndex: 0, keepMinutes: 45 },
    );

    expect(preview?.minutesFreed).toBe(15);
    expect(preview?.missingMinutes).toBe(0);
    expect(preview?.minutesLeftOver).toBe(0);
    expect(preview?.enoughRoom).toBe(true);
  });

  it("recommends the exact 15-minute shortening before a whole-task move", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Chemistry worksheet",
        durationMinutes: 60,
        priority: "low",
      }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const suggestions = buildRoomSuggestions({
      items,
      order: [0],
      newTaskIndex: 1,
      nowMinutes: 18 * 60,
      cutoffMinutes: 19 * 60,
    });

    expect(suggestions[0]?.adjustment).toEqual({
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 45,
    });
    expect(suggestions.some((suggestion) => suggestionHasKind(suggestion, "move"))).toBe(false);
  });

  it("offers a reasonable stop-time extension before a whole-task move", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Class",
        durationMinutes: 60,
        isFixed: true,
        fixedStart: "18:00",
        fixedEnd: "19:00",
      }),
      task({
        originalIndex: 1,
        title: "New task",
        durationMinutes: 15,
        suggestedDay: "tomorrow",
        dueDate: "2026-07-30",
        dueCategory: "future",
      }),
    ];
    const suggestions = buildRoomSuggestions({
      items,
      order: [],
      newTaskIndex: 1,
      nowMinutes: 18 * 60,
      cutoffMinutes: 19 * 60,
    });
    const preview = previewRoomAdjustment(
      { items, order: [], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      { kind: "extend", minutes: 15 },
    );

    expect(suggestions[0]?.adjustment).toEqual({ kind: "extend", minutes: 15 });
    expect(preview?.cutoffMinutes).toBe(19 * 60 + 15);
    expect(preview?.items.find((item) => item.originalIndex === 1)?.dueDate).toBe("2026-07-30");
  });

  it("still needs 10 minutes when a change frees 20 for a 30-minute task", () => {
    const items = [
      task({ originalIndex: 0, title: "Short task", durationMinutes: 20 }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 30, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 18 * 60 + 20 },
      { kind: "remove", targetIndex: 0 },
    );

    expect(preview?.minutesFreed).toBe(20);
    expect(preview?.newTaskNeededMinutes).toBe(30);
    expect(preview?.missingMinutes).toBe(10);
    expect(preview?.enoughRoom).toBe(false);
  });

  it("adds multiple freed-minute adjustments without counting a duplicate twice", () => {
    const items = [
      task({ originalIndex: 0, title: "First task", durationMinutes: 10 }),
      task({ originalIndex: 1, title: "Second task", durationMinutes: 15 }),
      task({ originalIndex: 2, title: "New task", durationMinutes: 25, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustments(
      { items, order: [0, 1], newTaskIndex: 2, nowMinutes: 18 * 60, cutoffMinutes: 18 * 60 + 25 },
      [
        { kind: "remove", targetIndex: 0 },
        { kind: "remove", targetIndex: 1 },
        { kind: "remove", targetIndex: 0 },
      ],
    );

    expect(preview?.adjustments).toHaveLength(2);
    expect(preview?.minutesFreed).toBe(25);
    expect(preview?.missingMinutes).toBe(0);
    expect(preview?.minutesLeftOver).toBe(0);
    expect(preview?.enoughRoom).toBe(true);
  });

  it("shortens a 90-minute block to 75 and keeps the original task today", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Chemistry worksheet",
        durationMinutes: 90,
        priority: "low",
        dueDate: "2026-07-30",
        dueCategory: "future",
      }),
      task({ originalIndex: 1, title: "test 7", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const context = {
      items,
      order: [0],
      newTaskIndex: 1,
      nowMinutes: 18 * 60,
      cutoffMinutes: 19 * 60 + 30,
    };
    const suggestions = buildRoomSuggestions(context);
    const preview = previewRoomAdjustment(context, {
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 75,
    });
    const chemistry = preview?.items.find((item) => item.originalIndex === 0);

    expect(suggestions[0]?.adjustment).toEqual({
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 75,
    });
    expect(chemistry?.durationMinutes).toBe(90);
    expect(chemistry?.todayDurationMinutes).toBe(75);
    expect(chemistry?.remainingDurationMinutes).toBe(15);
    expect(chemistry?.dueDate).toBe("2026-07-30");
    expect(
      preview?.items.filter((item) => item.title.includes("Chemistry worksheet")),
    ).toHaveLength(1);
    expect(preview?.result.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 15 }),
    );
  });

  it("shortens a 60-minute block to 40 and carries 20 minutes to tomorrow", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Flexible task",
        durationMinutes: 60,
        priority: "low",
      }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 20, suggestedDay: "tomorrow" }),
    ];
    const suggestions = buildRoomSuggestions({
      items,
      order: [0],
      newTaskIndex: 1,
      nowMinutes: 18 * 60,
      cutoffMinutes: 19 * 60,
    });

    expect(suggestions[0]?.adjustment).toEqual({
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 40,
    });
    const preview = previewRoomAdjustment(
      {
        items,
        order: [0],
        newTaskIndex: 1,
        nowMinutes: 18 * 60,
        cutoffMinutes: 19 * 60,
      },
      { kind: "shorten", targetIndex: 0, keepMinutes: 40 },
    );
    expect(preview?.result.schedule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemIndex: 0,
          startMinutes: 18 * 60,
          endMinutes: 18 * 60 + 40,
        }),
      ]),
    );
    expect(preview?.result.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 20 }),
    );
  });

  it("shortens a 45-minute block to 30 and persists the 15-minute continuation", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Finish Chemistry resonance worksheet",
        durationMinutes: 45,
        dueDate: "2026-07-25",
        dueCategory: "tomorrow",
        dueLabel: "Due tomorrow",
      }),
      task({ originalIndex: 1, title: "test 7", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const context = {
      items,
      order: [0],
      newTaskIndex: 1,
      nowMinutes: 18 * 60,
      cutoffMinutes: 18 * 60 + 45,
    };
    const preview = previewRoomAdjustment(context, {
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 30,
    });
    const chemistry = preview?.items.find((item) => item.originalIndex === 0);

    expect(chemistry?.todayDurationMinutes).toBe(30);
    expect(chemistry?.remainingDurationMinutes).toBe(15);
    expect(chemistry?.dueDate).toBe("2026-07-25");
    expect(preview?.result.tomorrow).toContainEqual(
      expect.objectContaining({
        itemIndex: 0,
        title: "Finish Chemistry resonance worksheet",
        remainingMinutes: 15,
        dueLabel: "Due tomorrow",
      }),
    );

    const rebuilt = preview
      ? buildSchedule({
          items: preview.items,
          order: preview.order,
          nowMinutes: context.nowMinutes,
          cutoffMinutes: context.cutoffMinutes,
        })
      : null;
    expect(rebuilt?.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 15 }),
    );
  });

  it("adds removed minutes to work that was already remaining", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Chemistry worksheet",
        durationMinutes: 65,
        todayDurationMinutes: 45,
        remainingDurationMinutes: 20,
      }),
      task({ originalIndex: 1, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const preview = previewRoomAdjustment(
      { items, order: [0], newTaskIndex: 1, nowMinutes: 18 * 60, cutoffMinutes: 19 * 60 },
      { kind: "shorten", targetIndex: 0, keepMinutes: 30 },
    );
    const chemistry = preview?.items.find((item) => item.originalIndex === 0);

    expect(chemistry?.todayDurationMinutes).toBe(30);
    expect(chemistry?.remainingDurationMinutes).toBe(35);
    expect(preview?.result.tomorrow).toContainEqual(
      expect.objectContaining({ itemIndex: 0, remainingMinutes: 35 }),
    );
  });

  it("combines a safe 10-minute and 5-minute shortening without moving a whole task", () => {
    const items = [
      task({ originalIndex: 0, title: "First task", durationMinutes: 25, priority: "low" }),
      task({ originalIndex: 1, title: "Second task", durationMinutes: 20, priority: "low" }),
      task({ originalIndex: 2, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const context = {
      items,
      order: [0, 1],
      newTaskIndex: 2,
      nowMinutes: 18 * 60,
      cutoffMinutes: 18 * 60 + 45,
    };
    const suggestions = buildRoomSuggestions(context);
    const adjustments = suggestions[0]?.adjustment;

    expect(adjustments).toEqual([
      { kind: "shorten", targetIndex: 0, keepMinutes: 15 },
      { kind: "shorten", targetIndex: 1, keepMinutes: 15 },
    ]);
    expect(
      Array.isArray(adjustments) && adjustments.some((adjustment) => adjustment.kind === "move"),
    ).toBe(false);
    const preview = Array.isArray(adjustments)
      ? previewRoomAdjustments(context, adjustments)
      : null;
    expect(preview?.minutesFreed).toBe(15);
    expect(preview?.enoughRoom).toBe(true);
  });

  it("does not refill the exact gap with an unrelated overflow task", () => {
    const items = [
      task({
        originalIndex: 0,
        title: "Chemistry worksheet",
        durationMinutes: 60,
        priority: "low",
      }),
      task({
        originalIndex: 1,
        title: "Unrelated low-priority task",
        durationMinutes: 30,
        priority: "low",
      }),
      task({ originalIndex: 2, title: "New task", durationMinutes: 15, suggestedDay: "tomorrow" }),
    ];
    const context = {
      items,
      order: [0, 1],
      newTaskIndex: 2,
      nowMinutes: 18 * 60,
      cutoffMinutes: 19 * 60,
    };
    const preview = previewRoomAdjustment(context, {
      kind: "shorten",
      targetIndex: 0,
      keepMinutes: 45,
    });

    expect(
      preview?.result.schedule.filter((entry) => entry.kind === "task").map((entry) => entry.title),
    ).toEqual(["Chemistry worksheet", "New task"]);
    expect(preview?.items.find((item) => item.originalIndex === 1)?.todayDurationMinutes).toBe(0);
    expect(preview?.result.tomorrow.some((item) => item.itemIndex === 1)).toBe(true);
  });
});
