import { buildSchedule, type BuildResult } from "./scheduler";
import type { PlanItem, Priority, ScheduleEntry } from "./planner.types";

export type RoomAdjustment =
  | { kind: "move"; targetIndex: number }
  | { kind: "shorten"; targetIndex: number; keepMinutes: number }
  | { kind: "start"; sessionMinutes: number }
  | { kind: "remove"; targetIndex: number };

export interface RoomSuggestion {
  id: string;
  title: string;
  detail: string;
  minutesCreated: number;
  adjustment: RoomAdjustment;
}

export interface RoomPreview {
  items: PlanItem[];
  order: number[];
  result: BuildResult;
  adjustment: RoomAdjustment;
  changedItemIndexes: number[];
  newTaskTodayIndex: number;
  summary: string;
}

interface RoomContext {
  items: PlanItem[];
  order: number[];
  newTaskIndex: number;
  nowMinutes: number;
  cutoffMinutes: number;
}

const priorityRank: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function itemMinutes(schedule: ScheduleEntry[], itemIndex: number) {
  return schedule
    .filter((entry) => entry.itemIndex === itemIndex)
    .reduce((total, entry) => total + (entry.endMinutes - entry.startMinutes), 0);
}

function nextIndex(items: PlanItem[]) {
  return items.reduce((max, item) => Math.max(max, item.originalIndex), -1) + 1;
}

function dueIsNotSooner(candidate: PlanItem, newTask: PlanItem) {
  if (!candidate.dueDate) return true;
  if (!newTask.dueDate) return false;
  return candidate.dueDate >= newTask.dueDate;
}

function applyDraft(context: RoomContext, adjustment: RoomAdjustment) {
  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return null;

  const draftItems = context.items.map((item) => ({ ...item }));
  let draftOrder = context.order.filter((index) => index !== context.newTaskIndex);
  let newTaskTodayIndex = context.newTaskIndex;
  const changedItemIndexes = [context.newTaskIndex];
  let summary = "";

  if (adjustment.kind === "move" || adjustment.kind === "remove") {
    const target = draftItems.find((item) => item.originalIndex === adjustment.targetIndex);
    if (!target || target.isFixed) return null;
    target.suggestedDay = "tomorrow";
    target.deferredByUser = true;
    if (adjustment.kind === "remove") {
      target.note = target.note || "Removed from today’s plan";
    }
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    draftOrder = [
      ...draftOrder.filter((index) => index !== target.originalIndex),
      task.originalIndex,
    ];
    changedItemIndexes.push(target.originalIndex);
    summary =
      adjustment.kind === "move"
        ? `Move “${target.title}” to tomorrow and make room for “${task.title}” today.`
        : `Remove “${target.title}” from today’s plan without deleting it, and make room for “${task.title}”.`;
  }

  if (adjustment.kind === "shorten") {
    const target = draftItems.find((item) => item.originalIndex === adjustment.targetIndex);
    if (
      !target ||
      target.isFixed ||
      adjustment.keepMinutes < 5 ||
      adjustment.keepMinutes >= target.durationMinutes
    ) {
      return null;
    }
    const remainder = target.durationMinutes - adjustment.keepMinutes;
    target.durationMinutes = adjustment.keepMinutes;
    const spilloverIndex = nextIndex(draftItems);
    draftItems.push({
      ...target,
      originalIndex: spilloverIndex,
      title: `Continue ${target.title}`,
      durationMinutes: remainder,
      suggestedDay: "tomorrow",
      deferredByUser: true,
      note: target.note || `Continue ${target.title}`,
    });
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    draftOrder = [
      ...draftOrder.filter((index) => index !== target.originalIndex),
      target.originalIndex,
      task.originalIndex,
    ];
    changedItemIndexes.push(target.originalIndex, spilloverIndex);
    summary = `Spend ${adjustment.keepMinutes} minutes on “${target.title}” today, continue it tomorrow, and make room for “${task.title}”.`;
  }

  if (adjustment.kind === "start") {
    if (adjustment.sessionMinutes < 5 || adjustment.sessionMinutes >= newTask.durationMinutes) {
      return null;
    }
    const tomorrowTask = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    tomorrowTask.durationMinutes -= adjustment.sessionMinutes;
    const todayIndex = nextIndex(draftItems);
    draftItems.push({
      ...tomorrowTask,
      originalIndex: todayIndex,
      title: `Start ${tomorrowTask.title}`,
      durationMinutes: adjustment.sessionMinutes,
      suggestedDay: "today",
      deferredByUser: false,
      note: tomorrowTask.note || `Start ${tomorrowTask.title}`,
    });
    newTaskTodayIndex = todayIndex;
    changedItemIndexes.push(todayIndex);
    draftOrder = [...draftOrder, todayIndex];
    summary = `Start “${tomorrowTask.title}” for ${adjustment.sessionMinutes} minutes today and continue it tomorrow.`;
  }

  const result = buildSchedule({
    items: draftItems,
    order: draftOrder,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });

  return {
    items: draftItems,
    order: draftOrder,
    result,
    adjustment,
    changedItemIndexes,
    newTaskTodayIndex,
    summary,
  } satisfies RoomPreview;
}

export function previewRoomAdjustment(context: RoomContext, adjustment: RoomAdjustment) {
  const baseline = buildSchedule({
    items: context.items,
    order: context.order,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });
  const preview = applyDraft(context, adjustment);
  if (!preview) return null;

  const expectedNewMinutes =
    adjustment.kind === "start"
      ? adjustment.sessionMinutes
      : (context.items.find((item) => item.originalIndex === context.newTaskIndex)
          ?.durationMinutes ?? 0);

  if (itemMinutes(preview.result.schedule, preview.newTaskTodayIndex) !== expectedNewMinutes) {
    return null;
  }

  const allowedChanges = new Set(preview.changedItemIndexes);
  for (const item of context.items) {
    if (allowedChanges.has(item.originalIndex)) continue;
    if (
      itemMinutes(baseline.schedule, item.originalIndex) !==
      itemMinutes(preview.result.schedule, item.originalIndex)
    ) {
      return null;
    }
  }

  return preview;
}

export function buildRoomSuggestions(context: RoomContext): RoomSuggestion[] {
  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return [];

  const baseline = buildSchedule({
    items: context.items,
    order: context.order,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });
  const candidates = context.items
    .filter(
      (item) =>
        item.originalIndex !== newTask.originalIndex &&
        item.suggestedDay === "today" &&
        !item.isFixed &&
        itemMinutes(baseline.schedule, item.originalIndex) > 0 &&
        priorityRank[item.priority] >= priorityRank[newTask.priority] &&
        dueIsNotSooner(item, newTask),
    )
    .sort(
      (a, b) =>
        priorityRank[b.priority] - priorityRank[a.priority] ||
        b.durationMinutes - a.durationMinutes,
    );

  const suggestions: RoomSuggestion[] = [];

  for (const candidate of candidates) {
    const adjustment: RoomAdjustment = { kind: "move", targetIndex: candidate.originalIndex };
    const preview = previewRoomAdjustment(context, adjustment);
    if (!preview) continue;
    const minutes = itemMinutes(baseline.schedule, candidate.originalIndex);
    suggestions.push({
      id: `move-${candidate.originalIndex}`,
      title: "Move a flexible task",
      detail: `Move “${candidate.title}” to tomorrow and use its ${minutes} minutes for this. You’ll confirm before anything changes.`,
      minutesCreated: minutes,
      adjustment,
    });
    break;
  }

  for (const candidate of candidates) {
    const keepOptions = [
      ...new Set([15, 20, Math.max(15, candidate.durationMinutes - newTask.durationMinutes)]),
    ]
      .filter((minutes) => minutes < candidate.durationMinutes)
      .sort((a, b) => b - a);
    let found = false;
    for (const keepMinutes of keepOptions) {
      const adjustment: RoomAdjustment = {
        kind: "shorten",
        targetIndex: candidate.originalIndex,
        keepMinutes,
      };
      const preview = previewRoomAdjustment(context, adjustment);
      if (!preview) continue;
      const created = candidate.durationMinutes - keepMinutes;
      suggestions.push({
        id: `shorten-${candidate.originalIndex}-${keepMinutes}`,
        title: "Shorten a task",
        detail: `Spend ${keepMinutes} minutes on “${candidate.title}” today and continue it tomorrow. This creates ${created} minutes. You’ll confirm before anything changes.`,
        minutesCreated: created,
        adjustment,
      });
      found = true;
      break;
    }
    if (found) break;
  }

  for (const sessionMinutes of [15, 10, 5]) {
    if (sessionMinutes >= newTask.durationMinutes) continue;
    const adjustment: RoomAdjustment = { kind: "start", sessionMinutes };
    if (!previewRoomAdjustment(context, adjustment)) continue;
    suggestions.push({
      id: `start-${sessionMinutes}`,
      title: "Use a shorter work session",
      detail: `Fit a ${sessionMinutes}-minute start on “${newTask.title}” today and continue tomorrow. You’ll confirm before anything changes.`,
      minutesCreated: sessionMinutes,
      adjustment,
    });
    break;
  }

  return suggestions.slice(0, 3);
}
