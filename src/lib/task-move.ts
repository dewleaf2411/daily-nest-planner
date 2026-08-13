import type { PlanItem, SuggestedDay } from "./planner.types";

export interface TaskMoveState {
  items: PlanItem[];
  userOrder: number[];
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Moves one task between plan days without changing its identity, due date, or
 * total work duration. Today timestamps are intentionally absent from this
 * state: buildSchedule derives them again from the current timeline.
 */
export function moveTaskToDay(
  state: TaskMoveState,
  taskIndex: number,
  day: SuggestedDay,
): TaskMoveState {
  const target = state.items.find((item) => item.originalIndex === taskIndex);
  if (!target || target.isFixed || target.itemType === "break") return state;

  const items = state.items.map((item) => {
    if (item.originalIndex !== taskIndex) return item;
    return day === "today"
      ? {
          ...item,
          suggestedDay: "today" as const,
          deferredByUser: false,
          todayDurationMinutes: item.durationMinutes,
          remainingDurationMinutes: 0,
        }
      : {
          ...item,
          suggestedDay: "tomorrow" as const,
          deferredByUser: true,
          todayDurationMinutes: 0,
          remainingDurationMinutes: item.durationMinutes,
        };
  });

  const orderWithoutTask = uniqueIds(state.userOrder).filter((id) => id !== taskIndex);
  return {
    items,
    userOrder: day === "today" ? [...orderWithoutTask, taskIndex] : orderWithoutTask,
  };
}
