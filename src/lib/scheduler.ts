import type {
  PlanItem,
  ScheduleEntry,
  SchedulingConflict,
  TomorrowEntry,
} from "./planner.types";

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

function roundUpTo5(m: number): number {
  return Math.ceil(m / 5) * 5;
}

function todayDuration(item: PlanItem): number {
  return Math.max(0, item.todayDurationMinutes ?? item.durationMinutes);
}

export function minutesToTimeLabel(mins: number): string {
  const total = ((mins % 1440) + 1440) % 1440;
  let h = Math.floor(total / 60);
  const m = total % 60;
  const mer = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${mer}`;
}

export function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h} hr${h > 1 ? "s" : ""}`;
  return `${h} hr${h > 1 ? "s" : ""} ${m} min`;
}

export interface BuildOptions {
  items: PlanItem[];
  order: number[];
  nowMinutes: number;
  cutoffMinutes: number;
  suppressedBreakIds?: string[];
}

export interface BuildResult {
  schedule: ScheduleEntry[];
  tomorrow: TomorrowEntry[];
  conflicts: SchedulingConflict[];
  scheduledMinutes: number;
}

interface FixedSlot {
  item: PlanItem;
  start: number;
  end: number;
}

interface OccupiedSlot {
  start: number;
  end: number;
}

function mergeOccupiedTime(fixed: FixedSlot[]): OccupiedSlot[] {
  const merged: OccupiedSlot[] = [];
  for (const slot of fixed) {
    const last = merged[merged.length - 1];
    if (last && slot.start <= last.end) {
      last.end = Math.max(last.end, slot.end);
    } else {
      merged.push({ start: slot.start, end: slot.end });
    }
  }
  return merged;
}

export function buildSchedule({
  items,
  order,
  nowMinutes,
  cutoffMinutes,
  suppressedBreakIds = [],
}: BuildOptions): BuildResult {
  const byIdx = new Map(items.map((item) => [item.originalIndex, item]));
  const suppressedBreaks = new Set(suppressedBreakIds);
  const schedule: ScheduleEntry[] = [];
  const tomorrow: TomorrowEntry[] = [];
  const addTomorrow = (item: PlanItem, minutes: number, reason?: string) => {
    if (minutes <= 0) return;
    const existing = tomorrow.find((entry) => entry.itemIndex === item.originalIndex);
    if (existing) {
      existing.remainingMinutes += minutes;
      return;
    }
    tomorrow.push({
      itemIndex: item.originalIndex,
      title: item.title,
      remainingMinutes: minutes,
      priority: item.priority,
      dueLabel: item.dueLabel ?? null,
      reason,
    });
  };

  const fixed = items
    .filter(
      (item) =>
        !item.removedFromPlan &&
        item.itemType !== "break" &&
        item.isFixed &&
        item.fixedStart &&
        item.suggestedDay === "today",
    )
    .map((item) => {
      const start = hhmmToMinutes(item.fixedStart!);
      const requestedEnd = item.fixedEnd ? hhmmToMinutes(item.fixedEnd) : start + item.durationMinutes;
      return { item, start, end: requestedEnd > start ? requestedEnd : start + item.durationMinutes };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const breaks = items
    .filter(
      (item) =>
        !item.removedFromPlan &&
        item.itemType === "break" &&
        item.fixedStart &&
        item.suggestedDay === "today",
    )
    .map((item) => {
      const start = hhmmToMinutes(item.fixedStart!);
      return { item, start, end: Math.min(cutoffMinutes, start + item.durationMinutes) };
    })
    .filter((slot) => slot.end > slot.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const occupied = mergeOccupiedTime(
    [...fixed, ...breaks].sort((a, b) => a.start - b.start || a.end - b.end),
  );

  for (const slot of fixed) {
    schedule.push({
      id: `fixed-${slot.item.originalIndex}`,
      itemIndex: slot.item.originalIndex,
      kind: "fixed",
      title: slot.item.title,
      startMinutes: slot.start,
      endMinutes: slot.end,
      isFirstBlock: true,
      totalDuration: slot.end - slot.start,
      priority: slot.item.priority,
      dueLabel: slot.item.dueLabel ?? null,
      isFixed: true,
    });
  }
  for (const slot of breaks) {
    schedule.push({
      id: `break-${slot.item.originalIndex}`,
      itemIndex: slot.item.originalIndex,
      kind: "break",
      title: slot.item.title,
      startMinutes: slot.start,
      endMinutes: slot.end,
      isLockedBreak: slot.item.breakLocked === true,
    });
  }

  const flexibleQueue: PlanItem[] = [];
  const queued = new Set<number>();
  for (const idx of order) {
    const item = byIdx.get(idx);
    if (
      !item ||
      item.removedFromPlan ||
      item.isFixed ||
      item.itemType === "break" ||
      item.suggestedDay !== "today" ||
      todayDuration(item) <= 0 ||
      queued.has(idx)
    ) {
      continue;
    }
    flexibleQueue.push(item);
    queued.add(idx);
  }
  for (const item of items) {
    if (
      !item.removedFromPlan &&
      !item.isFixed &&
      item.itemType !== "break" &&
      item.suggestedDay === "today" &&
      todayDuration(item) > 0 &&
      !queued.has(item.originalIndex)
    ) {
      flexibleQueue.push(item);
    }
  }
  flexibleQueue.sort(
    (a, b) =>
      Number(b.requiredToday || b.dueCategory === "today") -
      Number(a.requiredToday || a.dueCategory === "today"),
  );

  for (const item of items) {
    if (
      !item.removedFromPlan &&
      !item.isFixed &&
      item.itemType !== "break" &&
      item.suggestedDay === "tomorrow"
    ) {
      addTomorrow(
        item,
        item.durationMinutes,
        item.dueCategory === "today" ? "Couldn't fit today" : item.note ?? undefined,
      );
    }
    if (
      !item.removedFromPlan &&
      !item.isFixed &&
      item.itemType !== "break" &&
      item.suggestedDay === "today" &&
      (item.remainingDurationMinutes ?? 0) > 0
    ) {
      addTomorrow(item, item.remainingDurationMinutes ?? 0, "Remaining work");
    }
  }

  let cursor = roundUpTo5(Math.max(nowMinutes, 0));

  const placeBlock = (
    item: PlanItem,
    remaining: number,
    blockNum: number,
    totalBlocks: number,
    firstBlockDuration?: number,
  ): { placed: number; overflow: number } => {
    while (cursor < cutoffMinutes) {
      const nextOccupied = occupied.find(
        (slot) => slot.end > cursor && slot.start < cutoffMinutes,
      );
      if (nextOccupied && cursor >= nextOccupied.start) {
        cursor = roundUpTo5(nextOccupied.end);
        continue;
      }

      const wallEnd = nextOccupied ? nextOccupied.start : cutoffMinutes;
      const available = wallEnd - cursor;
      if (available <= 0) return { placed: 0, overflow: remaining };

      const desired = item.focusBlockMinutes
        ? Math.min(item.focusBlockMinutes, remaining)
        : remaining;
      if (item.focusBlockMinutes && nextOccupied && available < desired) {
        cursor = roundUpTo5(nextOccupied.end);
        continue;
      }

      const take = Math.min(desired, available);
      if (take <= 0) return { placed: 0, overflow: remaining };
      const start = cursor;
      const end = cursor + take;
      schedule.push({
        id: `t-${item.originalIndex}-b${blockNum}`,
        itemIndex: item.originalIndex,
        kind: "task",
        title: item.title,
        startMinutes: start,
        endMinutes: end,
        blockNumber: totalBlocks > 1 ? blockNum : undefined,
        totalBlocks: totalBlocks > 1 ? totalBlocks : undefined,
        isFirstBlock: blockNum === 1,
        totalDuration: blockNum === 1 ? firstBlockDuration ?? item.durationMinutes : undefined,
        focusBlockMinutes: item.focusBlockMinutes ?? null,
        priority: item.priority,
        dueLabel: item.dueLabel ?? null,
      });
      cursor = end;
      return { placed: take, overflow: remaining - take };
    }
    return { placed: 0, overflow: remaining };
  };

  for (const item of flexibleQueue) {
    const plannedMinutes = todayDuration(item);
    let remaining = plannedMinutes;
    const blocksTotal = item.focusBlockMinutes
      ? Math.ceil(plannedMinutes / item.focusBlockMinutes)
      : 1;
    let blockNum = 0;
    let placedAny = false;

    while (remaining > 0 && cursor < cutoffMinutes) {
      blockNum += 1;
      const beforeCursor = cursor;
      const { placed, overflow } = placeBlock(
        item,
        remaining,
        blockNum,
        blocksTotal,
        plannedMinutes,
      );
      if (placed === 0) break;
      placedAny = true;
      remaining = overflow;

      if (remaining > 0 && item.focusBlockMinutes) {
        const breakStart = cursor;
        const breakEnd = cursor + 5;
        const collidesWithFixed = occupied.some(
          (slot) => slot.start < breakEnd && slot.end > breakStart,
        );
        const breakId = `br-${item.originalIndex}-${blockNum}`;
        if (
          breakEnd <= cutoffMinutes &&
          !collidesWithFixed &&
          !suppressedBreaks.has(breakId)
        ) {
          schedule.push({
            id: breakId,
            itemIndex: -1,
            kind: "break",
            title: "Short break",
            startMinutes: breakStart,
            endMinutes: breakEnd,
          });
          cursor = breakEnd;
        }
      }
      if (beforeCursor === cursor) break;
    }

    if (remaining > 0 && !placedAny) {
      addTomorrow(item, remaining, "Couldn't fit today");
    }
  }

  schedule.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const filled: ScheduleEntry[] = [];
  const breakSlots = new Set<string>();
  const gapThreshold = 10;
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < schedule.length; i += 1) {
    const current = schedule[i];
    const currentBreakSlot = `${current.startMinutes}`;
    if (current.kind !== "break" || !breakSlots.has(currentBreakSlot)) {
      filled.push(current);
      if (current.kind === "break") breakSlots.add(currentBreakSlot);
    }
    coveredUntil = Math.max(coveredUntil, current.endMinutes);
    const next = schedule[i + 1];
    if (!next) continue;
    const gap = next.startMinutes - coveredUntil;
    const gapId = `gap-${coveredUntil}-${next.startMinutes}`;
    const gapSlot = `${coveredUntil}`;
    if (
      gap >= gapThreshold &&
      !suppressedBreaks.has(gapId) &&
      !breakSlots.has(gapSlot)
    ) {
      filled.push({
        id: gapId,
        itemIndex: -1,
        kind: "break",
        title: gap >= 30 ? "Rest & recharge" : "Breather",
        startMinutes: coveredUntil,
        endMinutes: next.startMinutes,
      });
      breakSlots.add(gapSlot);
    }
  }

  const scheduledTaskMinutes = new Map<number, number>();
  for (const entry of filled) {
    if (entry.kind !== "task") continue;
    scheduledTaskMinutes.set(
      entry.itemIndex,
      (scheduledTaskMinutes.get(entry.itemIndex) ?? 0) + entry.endMinutes - entry.startMinutes,
    );
  }

  const remainingByItem = new Map<number, number>();
  for (const item of items) {
    if (item.itemType === "break" || item.isFixed || item.removedFromPlan) continue;
    const scheduledForToday = scheduledTaskMinutes.get(item.originalIndex) ?? 0;
    const remaining = Math.max(0, todayDuration(item) - scheduledForToday);
    if (remaining > 0) remainingByItem.set(item.originalIndex, remaining);
  }

  const conflicts: SchedulingConflict[] = [];
  for (let first = 0; first < fixed.length; first += 1) {
    for (let second = first + 1; second < fixed.length; second += 1) {
      const overlapStart = Math.max(fixed[first].start, fixed[second].start);
      const overlapEnd = Math.min(fixed[first].end, fixed[second].end);
      if (overlapStart < overlapEnd) {
        conflicts.push({
          type: "fixed_overlap",
          firstItemIndex: fixed[first].item.originalIndex,
          secondItemIndex: fixed[second].item.originalIndex,
          overlapStartMinutes: overlapStart,
          overlapEndMinutes: overlapEnd,
        });
      }
    }
  }
  for (const breakSlot of breaks) {
    const otherSlots = [
      ...fixed.map((slot) => ({ ...slot, itemIndex: slot.item.originalIndex })),
      ...breaks
        .filter((slot) => slot.item.originalIndex > breakSlot.item.originalIndex)
        .map((slot) => ({ ...slot, itemIndex: slot.item.originalIndex })),
    ];
    for (const other of otherSlots) {
      const overlapStart = Math.max(breakSlot.start, other.start);
      const overlapEnd = Math.min(breakSlot.end, other.end);
      if (overlapStart < overlapEnd) {
        conflicts.push({
          type: "break_overlap",
          breakItemIndex: breakSlot.item.originalIndex,
          otherItemIndex: other.itemIndex,
          overlapStartMinutes: overlapStart,
          overlapEndMinutes: overlapEnd,
        });
      }
    }
  }

  const importantItems = items.filter(
    (item) =>
      !item.removedFromPlan &&
      !item.isFixed &&
      item.itemType !== "break" &&
      (item.requiredToday || item.dueCategory === "today"),
  );
  const affectedImportantItems = importantItems.filter(
    (item) => (remainingByItem.get(item.originalIndex) ?? 0) > 0,
  );
  const windowStart = roundUpTo5(Math.max(nowMinutes, 0));
  const blockedMinutes = mergeOccupiedTime(fixed).reduce(
    (total, slot) =>
      total + Math.max(0, Math.min(slot.end, cutoffMinutes) - Math.max(slot.start, windowStart)),
    0,
  );
  if (affectedImportantItems.length > 0 && blockedMinutes > 0) {
    conflicts.push({
      type: "fixed_displacement",
      fixedItemIndexes: fixed
        .filter((slot) => slot.end > windowStart && slot.start < cutoffMinutes)
        .map((slot) => slot.item.originalIndex),
      affectedItemIndexes: affectedImportantItems.map((item) => item.originalIndex),
      blockedMinutes,
    });
  }

  for (const item of items) {
    const remaining = remainingByItem.get(item.originalIndex) ?? 0;
    if (
      item.itemType !== "break" &&
      !item.isFixed &&
      item.dueCategory === "today" &&
      remaining > 0
    ) {
      conflicts.push({
        type: "due_today_unfit",
        itemIndex: item.originalIndex,
        dueDate: item.dueDate ?? null,
        remainingMinutes: remaining,
      });
    }
  }

  const requiredMinutes = importantItems.reduce(
    (total, item) => total + item.durationMinutes,
    0,
  );
  const scheduledRequiredMinutes = importantItems.reduce(
    (total, item) => total + Math.min(item.durationMinutes, scheduledTaskMinutes.get(item.originalIndex) ?? 0),
    0,
  );
  const missingRequiredMinutes = requiredMinutes - scheduledRequiredMinutes;
  if (missingRequiredMinutes > 0) {
    conflicts.push({
      type: "required_capacity",
      affectedItemIndexes: affectedImportantItems.map((item) => item.originalIndex),
      requiredMinutes,
      scheduledMinutes: scheduledRequiredMinutes,
      missingMinutes: missingRequiredMinutes,
    });
  }

  for (const item of items) {
    const scheduled = scheduledTaskMinutes.get(item.originalIndex) ?? 0;
    const remaining = remainingByItem.get(item.originalIndex) ?? 0;
    if (
      !item.isFixed &&
      item.dueCategory !== "today" &&
      !item.requiredToday &&
      scheduled > 0 &&
      remaining > 0
    ) {
      conflicts.push({ type: "task_overflow", itemIndex: item.originalIndex, remainingMinutes: remaining });
    }
  }

  const scheduledMinutes = filled.reduce(
    (total, entry) => total + entry.endMinutes - entry.startMinutes,
    0,
  );
  return { schedule: filled, tomorrow, conflicts, scheduledMinutes };
}

export function computeOrder(items: PlanItem[], userOrder: number[]): number[] {
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const flexToday = items
    .filter(
      (item) =>
        !item.removedFromPlan &&
        !item.isFixed &&
        item.itemType !== "break" &&
        item.suggestedDay === "today" &&
        todayDuration(item) > 0,
    )
    .map((item) => item.originalIndex);
  const isImportant = (index: number) => {
    const item = items.find((candidate) => candidate.originalIndex === index);
    return Boolean(item?.requiredToday || item?.dueCategory === "today");
  };
  // A manual order the user set by dragging always wins, including for
  // due-today tasks. Anything they haven't touched keeps the default
  // important-first, then priority ordering.
  const manual: number[] = [];
  for (const index of userOrder) {
    if (flexToday.includes(index) && !manual.includes(index)) manual.push(index);
  }
  const rest = flexToday
    .filter((index) => !manual.includes(index))
    .sort((a, b) => {
      const first = items.find((item) => item.originalIndex === a)!;
      const second = items.find((item) => item.originalIndex === b)!;
      return (
        Number(isImportant(b)) - Number(isImportant(a)) ||
        priorityRank[first.priority] - priorityRank[second.priority] ||
        a - b
      );
    });
  return [...manual, ...rest];
}
