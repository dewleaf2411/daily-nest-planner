import type { PlanItem, ScheduleEntry, TomorrowEntry } from "./planner.types";

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

function roundUpTo5(m: number): number {
  return Math.ceil(m / 5) * 5;
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
  order: number[]; // ordered originalIndex values for flexible tasks (today)
  nowMinutes: number;
  cutoffMinutes: number;
}

export interface BuildResult {
  schedule: ScheduleEntry[];
  tomorrow: TomorrowEntry[];
  scheduledMinutes: number;
  requiredTodayConflict: {
    requiredMinutes: number;
    scheduledMinutes: number;
    missingMinutes: number;
  } | null;
}

export function buildSchedule({ items, order, nowMinutes, cutoffMinutes }: BuildOptions): BuildResult {
  const byIdx = new Map(items.map((i) => [i.originalIndex, i]));
  const schedule: ScheduleEntry[] = [];
  const tomorrow: TomorrowEntry[] = [];

  // fixed commitments
  const fixed = items
    .filter((i) => i.isFixed && i.fixedStart && i.suggestedDay === "today")
    .map((i) => {
      const start = hhmmToMinutes(i.fixedStart!);
      const end = i.fixedEnd ? hhmmToMinutes(i.fixedEnd) : start + i.durationMinutes;
      return { item: i, start, end };
    })
    .sort((a, b) => a.start - b.start);

  for (const f of fixed) {
    schedule.push({
      id: `fixed-${f.item.originalIndex}`,
      itemIndex: f.item.originalIndex,
      kind: "fixed",
      title: f.item.title,
      startMinutes: f.start,
      endMinutes: f.end,
      isFirstBlock: true,
      totalDuration: f.item.durationMinutes,
      priority: f.item.priority,
      dueLabel: f.item.dueLabel ?? null,
      isFixed: true,
    });
  }

  // Required-today work always goes first. A user may reorder the remaining work,
  // but optional work must not displace an explicit same-day commitment.
  const flexibleQueue: PlanItem[] = [];
  const queued = new Set<number>();
  for (const idx of order) {
    const it = byIdx.get(idx);
    if (!it) continue;
    if (it.isFixed) continue;
    if (it.suggestedDay !== "today") continue;
    if (queued.has(it.originalIndex)) continue;
    flexibleQueue.push(it);
    queued.add(it.originalIndex);
  }
  for (const item of items) {
    if (!item.isFixed && item.suggestedDay === "today" && !queued.has(item.originalIndex)) flexibleQueue.push(item);
  }
  flexibleQueue.sort((a, b) => Number(b.requiredToday) - Number(a.requiredToday));

  // Also anything suggested tomorrow explicitly goes to tomorrow
  for (const it of items) {
    if (!it.isFixed && it.suggestedDay === "tomorrow") {
      tomorrow.push({
        itemIndex: it.originalIndex,
        title: it.title,
        remainingMinutes: it.durationMinutes,
        priority: it.priority,
        dueLabel: it.dueLabel ?? null,
        reason: it.note ?? undefined,
      });
    }
  }

  let cursor = roundUpTo5(Math.max(nowMinutes, 0));

  const placeBlock = (item: PlanItem, remaining: number, blockNum: number, totalBlocks: number, firstBlockDuration?: number): { placed: number; overflow: number } => {
    // find gap that doesn't collide with fixed
    while (cursor < cutoffMinutes) {
      const nextFixed = fixed.find((f) => f.start >= cursor && f.start < cutoffMinutes);
      const wallEnd = nextFixed ? nextFixed.start : cutoffMinutes;
      if (cursor >= wallEnd) {
        if (nextFixed) {
          cursor = roundUpTo5(nextFixed.end);
          continue;
        }
        return { placed: 0, overflow: remaining };
      }
      const available = wallEnd - cursor;
      if (available <= 0) {
        if (nextFixed) {
          cursor = roundUpTo5(nextFixed.end);
          continue;
        }
        return { placed: 0, overflow: remaining };
      }
      const desired = item.focusBlockMinutes && !item.isFixed ? Math.min(item.focusBlockMinutes, remaining) : remaining;
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

  let requiredTodayMinutes = 0;
  let scheduledRequiredTodayMinutes = 0;

  for (const item of flexibleQueue) {
    if (item.requiredToday) requiredTodayMinutes += item.durationMinutes;
    let remaining = item.durationMinutes;
    const blocksTotal = item.focusBlockMinutes ? Math.ceil(item.durationMinutes / item.focusBlockMinutes) : 1;
    let blockNum = 0;
    let placedAny = false;
    const originalTotal = item.durationMinutes;

    while (remaining > 0 && cursor < cutoffMinutes) {
      blockNum++;
      const beforeCursor = cursor;
      const { placed, overflow } = placeBlock(item, remaining, blockNum, blocksTotal, originalTotal);
      if (placed === 0) break;
      placedAny = true;
      if (item.requiredToday) scheduledRequiredTodayMinutes += placed;
      remaining = overflow;
      // break between focus blocks
      if (remaining > 0 && item.focusBlockMinutes) {
        const breakStart = cursor;
        const breakEnd = cursor + 5;
        if (breakEnd <= cutoffMinutes) {
          const nextFixed = fixed.find((f) => f.start >= cursor && f.start < cutoffMinutes);
          if (!nextFixed || breakEnd <= nextFixed.start) {
            schedule.push({
              id: `br-${item.originalIndex}-${blockNum}`,
              itemIndex: -1,
              kind: "break",
              title: "Short break",
              startMinutes: breakStart,
              endMinutes: breakEnd,
            });
            cursor = breakEnd;
          }
        }
      }
      if (beforeCursor === cursor) break;
    }

    if (remaining > 0) {
      tomorrow.push({
        itemIndex: item.originalIndex,
        title: item.title,
        remainingMinutes: remaining,
        priority: item.priority,
        dueLabel: item.dueLabel ?? null,
        reason: placedAny ? "Overflow from today" : "Didn't fit today",
      });
    }
  }

  schedule.sort((a, b) => a.startMinutes - b.startMinutes);
  // Fill leftover gaps between entries with a longer break so the day
  // doesn't have empty dead space before a fixed commitment.
  const GAP_THRESHOLD = 10; // minutes
  const filled: ScheduleEntry[] = [];
  for (let i = 0; i < schedule.length; i++) {
    const cur = schedule[i];
    filled.push(cur);
    const next = schedule[i + 1];
    if (!next) continue;
    const gap = next.startMinutes - cur.endMinutes;
    if (gap >= GAP_THRESHOLD) {
      filled.push({
        id: `gap-${cur.endMinutes}-${next.startMinutes}`,
        itemIndex: -1,
        kind: "break",
        title: gap >= 30 ? "Rest & recharge" : "Breather",
        startMinutes: cur.endMinutes,
        endMinutes: next.startMinutes,
      });
    }
  }

  const scheduledMinutes = filled.filter((s) => s.kind !== "break").reduce((a, s) => a + (s.endMinutes - s.startMinutes), 0);
  const missingMinutes = requiredTodayMinutes - scheduledRequiredTodayMinutes;
  return {
    schedule: filled,
    tomorrow,
    scheduledMinutes,
    requiredTodayConflict:
      missingMinutes > 0
        ? { requiredMinutes: requiredTodayMinutes, scheduledMinutes: scheduledRequiredTodayMinutes, missingMinutes }
        : null,
  };
}

export function computeOrder(items: PlanItem[], userOrder: number[]): number[] {
  // userOrder is the current user-defined order of flexible-today task indices
  // add any missing flexible-today items appended by priority then originalIndex
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const flexToday = items
    .filter((i) => !i.isFixed && i.suggestedDay === "today")
    .map((i) => i.originalIndex);
  const requiredToday = flexToday.filter((index) => items.find((item) => item.originalIndex === index)?.requiredToday);
  const seen = new Set(userOrder.filter((i) => flexToday.includes(i) && !requiredToday.includes(i)));
  const rest = flexToday
    .filter((i) => !seen.has(i) && !requiredToday.includes(i))
    .sort((a, b) => {
      const ia = items.find((x) => x.originalIndex === a)!;
      const ib = items.find((x) => x.originalIndex === b)!;
      const p = priorityRank[ia.priority] - priorityRank[ib.priority];
      if (p !== 0) return p;
      return ia.originalIndex - ib.originalIndex;
    });
  return [...requiredToday, ...userOrder.filter((i) => flexToday.includes(i) && !requiredToday.includes(i)), ...rest];
}
