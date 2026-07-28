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
  adjustment: RoomAdjustment | RoomAdjustment[];
}

export interface RoomImpact {
  kind: RoomAdjustment["kind"];
  taskIndex: number | null;
  title: string;
  beforeMinutes: number;
  afterMinutes: number;
  minutesFreed: number;
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
  impacts: RoomImpact[];
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

export interface RoomContext {
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

function dueIsNotSooner(candidate: PlanItem, newTask: PlanItem) {
  if (!candidate.dueDate) return true;
  if (!newTask.dueDate) return true;
  return candidate.dueDate >= newTask.dueDate;
}

function applyDraft(context: RoomContext, adjustment: RoomAdjustment): RoomPreview | null {
  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return null;

  const baseline = buildSchedule({
    items: context.items,
    order: context.order,
    nowMinutes: context.nowMinutes,
    cutoffMinutes: context.cutoffMinutes,
  });
  const draftItems = context.items.map((item) => ({ ...item }));
  for (const item of draftItems) {
    if (
      item.originalIndex === context.newTaskIndex ||
      item.isFixed ||
      item.suggestedDay !== "today" ||
      item.removedFromPlan
    ) {
      continue;
    }
    const plannedMinutes = itemMinutes(baseline.schedule, item.originalIndex);
    item.todayDurationMinutes = plannedMinutes;
    item.remainingDurationMinutes = Math.max(
      item.remainingDurationMinutes ?? 0,
      item.durationMinutes - plannedMinutes,
    );
  }
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
      target.todayDurationMinutes = 0;
      target.remainingDurationMinutes = target.durationMinutes;
    } else {
      target.removedFromPlan = true;
      target.deferredByUser = false;
      target.todayDurationMinutes = 0;
      target.remainingDurationMinutes = target.durationMinutes;
      target.note = target.note || "Removed from today’s plan";
    }
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    task.removedFromPlan = false;
    task.todayDurationMinutes = task.durationMinutes;
    task.remainingDurationMinutes = 0;
    draftOrder = draftOrder.filter(
      (index) => index !== target.originalIndex && index !== task.originalIndex,
    );
    draftOrder.push(task.originalIndex);
    changedItemIndexes.push(target.originalIndex);
    summary =
      adjustment.kind === "move"
        ? `Move “${target.title}” to tomorrow and make room for “${task.title}” today.`
        : `Remove “${target.title}” from today’s plan without deleting it, and make room for “${task.title}”.`;
  }

  if (adjustment.kind === "shorten") {
    const target = draftItems.find((item) => item.originalIndex === adjustment.targetIndex);
    const currentTodayMinutes = target?.todayDurationMinutes ?? target?.durationMinutes ?? 0;
    if (
      !target ||
      target.isFixed ||
      !Number.isInteger(adjustment.keepMinutes) ||
      adjustment.keepMinutes < 1 ||
      adjustment.keepMinutes >= currentTodayMinutes
    ) {
      return null;
    }
    target.removedFromPlan = false;
    const removedMinutes = currentTodayMinutes - adjustment.keepMinutes;
    const existingRemainingMinutes = target.remainingDurationMinutes ?? 0;
    target.todayDurationMinutes = adjustment.keepMinutes;
    target.remainingDurationMinutes = existingRemainingMinutes + removedMinutes;
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    task.removedFromPlan = false;
    task.todayDurationMinutes = task.durationMinutes;
    task.remainingDurationMinutes = 0;
    const targetPosition = Math.max(0, draftOrder.indexOf(target.originalIndex));
    draftOrder = draftOrder.filter(
      (index) => index !== target.originalIndex && index !== task.originalIndex,
    );
    draftOrder.splice(Math.min(targetPosition, draftOrder.length), 0, target.originalIndex);
    draftOrder.push(task.originalIndex);
    changedItemIndexes.push(target.originalIndex);
    summary = `Shorten “${target.title}” by ${currentTodayMinutes - adjustment.keepMinutes} minutes and make room for “${task.title}”.`;
  }

  if (adjustment.kind === "start") {
    if (adjustment.sessionMinutes < 5 || adjustment.sessionMinutes >= newTask.durationMinutes) {
      return null;
    }
    const task = draftItems.find((item) => item.originalIndex === context.newTaskIndex)!;
    task.removedFromPlan = false;
    task.suggestedDay = "today";
    task.deferredByUser = false;
    task.todayDurationMinutes = adjustment.sessionMinutes;
    task.remainingDurationMinutes = task.durationMinutes - adjustment.sessionMinutes;
    newTaskTodayIndex = task.originalIndex;
    draftOrder = [...draftOrder, task.originalIndex];
    summary = `Start “${task.title}” for ${adjustment.sessionMinutes} minutes today and leave ${task.remainingDurationMinutes} minutes for later.`;
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
    task.todayDurationMinutes = task.durationMinutes;
    task.remainingDurationMinutes = 0;
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
    impacts: [],
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

export function getRoomMinutesNeeded(context: RoomContext, requestedMinutes?: number) {
  const newTask = context.items.find((item) => item.originalIndex === context.newTaskIndex);
  if (!newTask) return 0;
  const expectedMinutes = requestedMinutes ?? newTask.durationMinutes;
  const baselineItems = context.items.map((item) =>
    item.originalIndex === context.newTaskIndex
      ? {
          ...item,
          suggestedDay: "today" as const,
          deferredByUser: false,
          removedFromPlan: false,
          todayDurationMinutes: expectedMinutes,
          remainingDurationMinutes: Math.max(0, item.durationMinutes - expectedMinutes),
        }
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
    expectedMinutes,
    itemMinutes(baselineWithNewTask.schedule, context.newTaskIndex),
  );
  return Math.max(0, expectedMinutes - baselineNewTaskMinutes);
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
  const newTaskNeededMinutes = getRoomMinutesNeeded(context, expectedNewMinutes);

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
  const impactedTargets = new Set<number>();
  const impacts: RoomImpact[] = [];
  for (const adjustment of deduplicated) {
    if (adjustment.kind === "extend") {
      impacts.push({
        kind: adjustment.kind,
        taskIndex: null,
        title: "Available-until time",
        beforeMinutes: context.cutoffMinutes,
        afterMinutes: context.cutoffMinutes + adjustment.minutes,
        minutesFreed: adjustment.minutes,
      });
      continue;
    }
    if (adjustment.kind === "start") {
      impacts.push({
        kind: adjustment.kind,
        taskIndex: context.newTaskIndex,
        title: newTask.title,
        beforeMinutes: 0,
        afterMinutes: adjustment.sessionMinutes,
        minutesFreed: 0,
      });
      continue;
    }
    if (impactedTargets.has(adjustment.targetIndex)) continue;
    impactedTargets.add(adjustment.targetIndex);
    const impactedTask = context.items.find(
      (item) => item.originalIndex === adjustment.targetIndex,
    );
    const beforeMinutes = itemMinutes(baseline.schedule, adjustment.targetIndex);
    const afterMinutes = itemMinutes(preview.result.schedule, adjustment.targetIndex);
    impacts.push({
      kind: adjustment.kind,
      taskIndex: adjustment.targetIndex,
      title: impactedTask?.title ?? "Task",
      beforeMinutes,
      afterMinutes,
      minutesFreed: Math.max(0, beforeMinutes - afterMinutes),
    });
  }

  preview.adjustment = primaryAdjustment;
  preview.adjustments = deduplicated;
  preview.changedItemIndexes = [...changedItemIndexes];
  preview.impacts = impacts;
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
  const minutesNeeded = getRoomMinutesNeeded(context);
  const baselineNewTaskMinutes = newTask.durationMinutes - minutesNeeded;
  const candidates = context.items
    .filter(
      (item) =>
        item.originalIndex !== newTask.originalIndex &&
        item.itemType !== "break" &&
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
  const minimumSafeBlockMinutes = 15;

  for (const candidate of candidates) {
    const currentMinutes = itemMinutes(baseline.schedule, candidate.originalIndex);
    const keepMinutes = currentMinutes - minutesNeeded;
    if (
      minutesNeeded <= 0 ||
      currentMinutes !== candidate.durationMinutes ||
      keepMinutes < minimumSafeBlockMinutes ||
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

  if (suggestions.length === 0 && minutesNeeded > 0) {
    const reductions: RoomAdjustment[] = [];
    const reductionDetails: string[] = [];
    let stillNeeded = minutesNeeded;
    for (const candidate of candidates) {
      const currentMinutes = itemMinutes(baseline.schedule, candidate.originalIndex);
      const safelyAvailable = Math.max(0, currentMinutes - minimumSafeBlockMinutes);
      const takeMinutes = Math.min(safelyAvailable, stillNeeded);
      if (takeMinutes <= 0) continue;
      reductions.push({
        kind: "shorten",
        targetIndex: candidate.originalIndex,
        keepMinutes: currentMinutes - takeMinutes,
      });
      reductionDetails.push(`Shorten “${candidate.title}” by ${takeMinutes} minutes.`);
      stillNeeded -= takeMinutes;
      if (stillNeeded === 0) break;
    }

    const hasShorteningAdjustment = reductions.length > 0;
    if (
      hasShorteningAdjustment &&
      stillNeeded > 0 &&
      stillNeeded <= 60 &&
      context.cutoffMinutes + stillNeeded <= 23 * 60 + 59
    ) {
      reductions.push({ kind: "extend", minutes: stillNeeded });
      reductionDetails.push(`Use ${stillNeeded} more minutes today.`);
      stillNeeded = 0;
    }

    if (hasShorteningAdjustment && stillNeeded === 0) {
      const preview = previewRoomAdjustments(context, reductions);
      if (preview?.enoughRoom && preview.newTaskScheduledMinutes >= newTask.durationMinutes) {
        suggestions.push({
          id: `combined-${reductions.map(adjustmentKey).join("-")}`,
          title: `Make ${minutesNeeded} minutes of room`,
          detail: `${reductionDetails.join(" ")} This creates exactly enough room for “${newTask.title}”. You’ll confirm before anything changes.`,
          minutesCreated: minutesNeeded,
          adjustment: reductions,
        });
      }
    }
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

  for (const sessionMinutes of [15, 10, 5].filter((minutes) => minutes <= baselineNewTaskMinutes)) {
    if (sessionMinutes >= newTask.durationMinutes) continue;
    const adjustment: RoomAdjustment = { kind: "start", sessionMinutes };
    const preview = previewRoomAdjustment(context, adjustment);
    if (!preview?.enoughRoom || preview.newTaskScheduledMinutes < sessionMinutes) continue;
    suggestions.push({
      id: `start-${sessionMinutes}`,
      title: "Use a shorter work session",
      detail: `Fit a ${sessionMinutes}-minute start on “${newTask.title}” today and leave the rest for later. You’ll confirm before anything changes.`,
      minutesCreated: sessionMinutes,
      adjustment,
    });
    break;
  }

  return suggestions.slice(0, 3);
}
