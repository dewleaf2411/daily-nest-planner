import { buildSchedule, type BuildResult } from "./scheduler";
import type { PlanItem, Priority, ScheduleEntry } from "./planner.types";

export type RoomAdjustment =
  | { kind: "move"; targetIndex: number }
  | { kind: "shorten"; targetIndex: number; keepMinutes: number }
  | { kind: "start"; sessionMinutes: number }
  | { kind: "remove"; targetIndex: number }
  | { kind: "extend"; minutes: number };

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
  adjustments: RoomAdjustment[];
  changedItemIndexes: number[];
  newTaskTodayIndex: number;
  cutoffMinutes: number;
  summary: string;
  affectedTaskTitle: string | null;
  affectedCurrentMinutes: number;
  affectedAfterMinutes: number;
  minutesFreed: number;
  newTaskNeededMinutes: number;
  newTaskScheduledMinutes: number;
  missingMinutes: number;
  minutesLeftOver: number;
  enoughRoom: boolean;
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

function applyDraft(context: RoomContext, adjustment: RoomAdjustment): RoomPreview | null {
  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return null;

  const draftItems = context.items.map((item) => ({ ...item }));
  let draftOrder = context.order.filter((index) => index !== context.newTaskIndex);
  let newTaskTodayIndex = context.newTaskIndex;
  const changedItemIndexes = [context.newTaskIndex];
  let summary = "";
  let previewCutoffMinutes = context.cutoffMinutes;

  if (adjustment.kind === "move" || adjustment.kind === "remove") {
    const target = draftItems.find((item) => item.originalIndex === adjustment.targetIndex);
    if (!target || target.isFixed) return null;
    if (adjustment.kind === "move") {
      target.suggestedDay = "tomorrow";
      target.deferredByUser = true;
      target.removedFromPlan = false;
    } else {
      target.removedFromPlan = true;
      target.deferredByUser = false;
      target.note = target.note || "Removed from today’s plan";
    }
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    task.removedFromPlan = false;
    const targetPosition = Math.max(0, draftOrder.indexOf(target.originalIndex));
    draftOrder = draftOrder.filter(
      (index) => index !== target.originalIndex && index !== task.originalIndex,
    );
    draftOrder.splice(targetPosition, 0, task.originalIndex);
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
    target.removedFromPlan = false;
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
    task.removedFromPlan = false;
    const targetPosition = Math.max(0, draftOrder.indexOf(target.originalIndex));
    draftOrder = draftOrder.filter(
      (index) => index !== target.originalIndex && index !== task.originalIndex,
    );
    draftOrder.splice(targetPosition, 0, target.originalIndex, task.originalIndex);
    changedItemIndexes.push(target.originalIndex, spilloverIndex);
    summary = `Spend ${adjustment.keepMinutes} minutes on “${target.title}” today, continue it tomorrow, and make room for “${task.title}”.`;
  }

  if (adjustment.kind === "start") {
    if (adjustment.sessionMinutes < 5 || adjustment.sessionMinutes >= newTask.durationMinutes) {
      return null;
    }
    const tomorrowTask = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    tomorrowTask.removedFromPlan = false;
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

  if (adjustment.kind === "extend") {
    if (
      adjustment.minutes <= 0 ||
      !Number.isInteger(adjustment.minutes) ||
      context.cutoffMinutes + adjustment.minutes > 23 * 60 + 59
    ) {
      return null;
    }
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    task.removedFromPlan = false;
    draftOrder = [
      ...draftOrder.filter((index) => index !== task.originalIndex),
      task.originalIndex,
    ];
    previewCutoffMinutes += adjustment.minutes;
    summary = `Extend today by ${adjustment.minutes} minutes to make room for “${task.title}”.`;
  }

  const result = buildSchedule({
    items: draftItems,
    order: draftOrder,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: previewCutoffMinutes,
  });

  return {
    items: draftItems,
    order: draftOrder,
    result,
    adjustment,
    adjustments: [adjustment],
    changedItemIndexes,
    newTaskTodayIndex,
    cutoffMinutes: previewCutoffMinutes,
    summary,
    affectedTaskTitle: null,
    affectedCurrentMinutes: 0,
    affectedAfterMinutes: 0,
    minutesFreed: 0,
    newTaskNeededMinutes: 0,
    newTaskScheduledMinutes: 0,
    missingMinutes: 0,
    minutesLeftOver: 0,
    enoughRoom: false,
  } satisfies RoomPreview;
}

function adjustmentKey(adjustment: RoomAdjustment) {
  if (adjustment.kind === "shorten") {
    return `${adjustment.kind}:${adjustment.targetIndex}:${adjustment.keepMinutes}`;
  }
  if (adjustment.kind === "move" || adjustment.kind === "remove") {
    return `${adjustment.kind}:${adjustment.targetIndex}`;
  }
  if (adjustment.kind === "start") return `${adjustment.kind}:${adjustment.sessionMinutes}`;
  return `${adjustment.kind}:${adjustment.minutes}`;
}

function uniqueAdjustments(adjustments: RoomAdjustment[]) {
  const seen = new Set<string>();
  return adjustments.filter((adjustment) => {
    const key = adjustmentKey(adjustment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function previewRoomAdjustments(
  context: RoomContext,
  adjustments: RoomAdjustment[],
): RoomPreview | null {
  const deduplicated = uniqueAdjustments(adjustments);
  if (deduplicated.length === 0) return null;

  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return null;

  const baseline = buildSchedule({
    items: context.items,
    order: context.order,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });

  const partialStart = deduplicated.find(
    (adjustment): adjustment is Extract<RoomAdjustment, { kind: "start" }> =>
      adjustment.kind === "start",
  );
  const expectedNewMinutes = partialStart?.sessionMinutes ?? newTask.durationMinutes;
  const baselineItems = context.items.map((item) =>
    item.originalIndex === context.newTaskIndex
      ? { ...item, suggestedDay: "today" as const, deferredByUser: false, removedFromPlan: false }
      : { ...item },
  );
  const baselineWithNewTask = buildSchedule({
    items: baselineItems,
    order: [
      ...context.order.filter((index) => index !== context.newTaskIndex),
      context.newTaskIndex,
    ],
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });
  const baselineNewTaskMinutes = Math.min(
    expectedNewMinutes,
    itemMinutes(baselineWithNewTask.schedule, context.newTaskIndex),
  );
  const newTaskNeededMinutes = Math.max(0, expectedNewMinutes - baselineNewTaskMinutes);

  let workingContext = context;
  let preview: RoomPreview | null = null;
  const changedItemIndexes = new Set<number>();
  for (const adjustment of deduplicated) {
    preview = applyDraft(workingContext, adjustment);
    if (!preview) return null;
    preview.changedItemIndexes.forEach((index) => changedItemIndexes.add(index));
    workingContext = {
      ...workingContext,
      items: preview.items,
      order: preview.order,
      cutoffMinutes: preview.cutoffMinutes,
    };
  }
  if (!preview) return null;

  const totalMinutesFreed = deduplicated.reduce((total, adjustment) => {
    if (adjustment.kind === "extend") return total + adjustment.minutes;
    if (adjustment.kind === "start") return total;
    const currentMinutes = itemMinutes(baseline.schedule, adjustment.targetIndex);
    if (adjustment.kind === "shorten") {
      return total + Math.max(0, currentMinutes - adjustment.keepMinutes);
    }
    return total + currentMinutes;
  }, 0);
  const missingMinutes = Math.max(0, newTaskNeededMinutes - totalMinutesFreed);
  const minutesLeftOver = Math.max(0, totalMinutesFreed - newTaskNeededMinutes);

  const primaryAdjustment = deduplicated[0];
  const targetIndex = "targetIndex" in primaryAdjustment ? primaryAdjustment.targetIndex : null;
  const target =
    targetIndex === null
      ? null
      : (context.items.find((item) => item.originalIndex === targetIndex) ?? null);
  const affectedCurrentMinutes =
    targetIndex === null ? 0 : itemMinutes(baseline.schedule, targetIndex);
  const affectedAfterMinutes =
    targetIndex === null ? 0 : itemMinutes(preview.result.schedule, targetIndex);
  const newTaskScheduledMinutes = itemMinutes(preview.result.schedule, preview.newTaskTodayIndex);

  preview.adjustment = primaryAdjustment;
  preview.adjustments = deduplicated;
  preview.changedItemIndexes = [...changedItemIndexes];
  preview.affectedTaskTitle = target?.title ?? null;
  preview.affectedCurrentMinutes = affectedCurrentMinutes;
  preview.affectedAfterMinutes = affectedAfterMinutes;
  preview.minutesFreed = totalMinutesFreed;
  preview.newTaskNeededMinutes = newTaskNeededMinutes;
  preview.newTaskScheduledMinutes = newTaskScheduledMinutes;
  preview.missingMinutes = missingMinutes;
  preview.minutesLeftOver = minutesLeftOver;
  preview.enoughRoom = missingMinutes === 0;

  return preview;
}

export function previewRoomAdjustment(context: RoomContext, adjustment: RoomAdjustment) {
  return previewRoomAdjustments(context, [adjustment]);
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
  const baselineItems = context.items.map((item) =>
    item.originalIndex === newTask.originalIndex
      ? { ...item, suggestedDay: "today" as const, deferredByUser: false, removedFromPlan: false }
      : { ...item },
  );
  const baselineWithNewTask = buildSchedule({
    items: baselineItems,
    order: [
      ...context.order.filter((index) => index !== newTask.originalIndex),
      newTask.originalIndex,
    ],
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });
  const baselineNewTaskMinutes = itemMinutes(baselineWithNewTask.schedule, newTask.originalIndex);
  const minutesNeeded = Math.max(0, newTask.durationMinutes - baselineNewTaskMinutes);
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
    const currentMinutes = itemMinutes(baseline.schedule, candidate.originalIndex);
    const keepMinutes = currentMinutes - minutesNeeded;
    if (
      minutesNeeded <= 0 ||
      currentMinutes !== candidate.durationMinutes ||
      keepMinutes <= 0 ||
      keepMinutes >= candidate.durationMinutes
    ) {
      continue;
    }
    const adjustment: RoomAdjustment = {
      kind: "shorten",
      targetIndex: candidate.originalIndex,
      keepMinutes,
    };
    const preview = previewRoomAdjustment(context, adjustment);
    if (!preview?.enoughRoom || preview.newTaskScheduledMinutes < newTask.durationMinutes) continue;
    suggestions.push({
      id: `shorten-${candidate.originalIndex}-${keepMinutes}`,
      title: `Shorten ${candidate.title} by ${minutesNeeded} minutes`,
      detail: `Work on it for ${keepMinutes} minutes today instead of ${currentMinutes} minutes. This creates exactly ${minutesNeeded} minutes for “${newTask.title}”. You’ll confirm before anything changes.`,
      minutesCreated: minutesNeeded,
      adjustment,
    });
    break;
  }

  for (const sessionMinutes of [15, 10, 5].filter((minutes) => minutes <= baselineNewTaskMinutes)) {
    if (sessionMinutes >= newTask.durationMinutes) continue;
    const adjustment: RoomAdjustment = { kind: "start", sessionMinutes };
    const preview = previewRoomAdjustment(context, adjustment);
    if (!preview?.enoughRoom || preview.newTaskScheduledMinutes < sessionMinutes) continue;
    suggestions.push({
      id: `start-${sessionMinutes}`,
      title: "Use a shorter work session",
      detail: `Fit a ${sessionMinutes}-minute start on “${newTask.title}” today and continue tomorrow. You’ll confirm before anything changes.`,
      minutesCreated: sessionMinutes,
      adjustment,
    });
    break;
  }

  if (
    minutesNeeded > 0 &&
    minutesNeeded <= 60 &&
    context.cutoffMinutes + minutesNeeded <= 23 * 60 + 59
  ) {
    const adjustment: RoomAdjustment = { kind: "extend", minutes: minutesNeeded };
    const preview = previewRoomAdjustment(context, adjustment);
    if (preview?.enoughRoom && preview.newTaskScheduledMinutes >= newTask.durationMinutes) {
      suggestions.push({
        id: `extend-${minutesNeeded}`,
        title: `Use ${minutesNeeded} more minutes today`,
        detail: `Move your available-until time ${minutesNeeded} minutes later. Your due dates stay the same, and you’ll confirm before anything changes.`,
        minutesCreated: minutesNeeded,
        adjustment,
      });
    }
  }

  if (suggestions.length === 0) {
    for (const candidate of candidates) {
      const adjustment: RoomAdjustment = { kind: "move", targetIndex: candidate.originalIndex };
      const preview = previewRoomAdjustment(context, adjustment);
      if (!preview?.enoughRoom || preview.newTaskScheduledMinutes < newTask.durationMinutes)
        continue;
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
  }

  return suggestions.slice(0, 3);
}
