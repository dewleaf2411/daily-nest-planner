import { describe, expect, it } from "vitest";
import { buildRoomSuggestions, previewRoomAdjustment } from "./full-day-flow";
import type { PlanItem } from "./planner.types";

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
    expect(suggestions.some((suggestion) => suggestion.adjustment.kind === "move")).toBe(false);
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
    expect(preview?.items.find((item) => item.originalIndex === 0)?.durationMinutes).toBe(30);
    expect(preview?.result.schedule).toHaveLength(1);
    expect(preview?.result.tomorrow.some((item) => item.itemIndex === 0)).toBe(true);
  });
});
