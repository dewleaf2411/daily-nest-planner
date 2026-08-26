import type { PlanItem } from "./planner.types";
import { buildSchedule, computeOrder } from "./scheduler";

interface SameDayBreakInsertionOptions {
  items: PlanItem[];
  userOrder: number[];
  sourceEntryId: string;
  sourceItemIndex: number;
  beforeEntryId: string | null;
  beforeTaskId: number | null;
  nowMinutes: number;
  cutoffMinutes: number;
  suppressedBreakIds?: string[];
}

/** Find a moved break's destination from a timeline rebuilt without it. */
export function getSameDayBreakInsertionStart({
  items,
  userOrder,
  sourceEntryId,
  sourceItemIndex,
  beforeEntryId,
  beforeTaskId,
  nowMinutes,
  cutoffMinutes,
  suppressedBreakIds = [],
}: SameDayBreakInsertionOptions): number | null {
  const baseline = buildSchedule({
    items,
    order: computeOrder(items, userOrder),
    nowMinutes,
    cutoffMinutes,
    suppressedBreakIds,
  });
  const generatedSource =
    sourceItemIndex < 0
      ? baseline.schedule.find((entry) => entry.id === sourceEntryId)
      : null;
  const itemsWithoutSource =
    sourceItemIndex >= 0
      ? items.filter((item) => item.originalIndex !== sourceItemIndex)
      : items;
  const suppressedWithoutSource =
    sourceItemIndex < 0 && !suppressedBreakIds.includes(sourceEntryId)
      ? [...suppressedBreakIds, sourceEntryId]
      : suppressedBreakIds;
  const sourceFree = buildSchedule({
    items: itemsWithoutSource,
    order: computeOrder(itemsWithoutSource, userOrder),
    nowMinutes,
    cutoffMinutes,
    suppressedBreakIds: suppressedWithoutSource,
  });

  const removeGeneratedSourceDuration = (startMinutes: number) => {
    if (!generatedSource || startMinutes < generatedSource.endMinutes) {
      return startMinutes;
    }
    return startMinutes - (generatedSource.endMinutes - generatedSource.startMinutes);
  };

  const beforeEntry = beforeEntryId
    ? sourceFree.schedule.find((entry) => entry.id === beforeEntryId)
    : null;
  if (beforeEntry) return removeGeneratedSourceDuration(beforeEntry.startMinutes);

  const beforeTask =
    beforeTaskId === null
      ? null
      : sourceFree.schedule.find(
          (entry) => entry.kind === "task" && entry.itemIndex === beforeTaskId,
        );
  if (beforeTask) return removeGeneratedSourceDuration(beforeTask.startMinutes);

  if (beforeEntryId !== null || beforeTaskId !== null) return null;
  const endMinutes = sourceFree.schedule.reduce(
    (latest, entry) => Math.max(latest, entry.endMinutes),
    Math.ceil(Math.max(0, nowMinutes) / 5) * 5,
  );
  return removeGeneratedSourceDuration(endMinutes);
}
