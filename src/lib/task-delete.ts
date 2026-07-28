import type { PlanItem } from "./planner.types";

type LinkedPlanItem = PlanItem & { parentTaskIndex?: number };

export interface TaskPlanState {
  items: PlanItem[];
  userOrder: number[];
  completedTasks: Set<number>;
  splitMinutes: Record<number, number>;
}

export function getTaskDeletionIndexes(items: PlanItem[], targetIndex: number): Set<number> {
  const linkedItems = items as LinkedPlanItem[];
  const target = linkedItems.find((item) => item.originalIndex === targetIndex);
  if (!target || target.isFixed) return new Set();

  const rootIndex = target.parentTaskIndex ?? target.originalIndex;
  return new Set(
    linkedItems
      .filter(
        (item) =>
          !item.isFixed &&
          (item.originalIndex === rootIndex || item.parentTaskIndex === rootIndex),
      )
      .map((item) => item.originalIndex),
  );
}

export function deleteTaskFromPlanState(
  state: TaskPlanState,
  targetIndex: number | null,
): TaskPlanState {
  if (targetIndex === null) return state;
  const deletedIndexes = getTaskDeletionIndexes(state.items, targetIndex);
  if (deletedIndexes.size === 0) return state;

  return {
    items: state.items.filter((item) => !deletedIndexes.has(item.originalIndex)),
    userOrder: state.userOrder.filter((index) => !deletedIndexes.has(index)),
    completedTasks: new Set(
      [...state.completedTasks].filter((index) => !deletedIndexes.has(index)),
    ),
    splitMinutes: Object.fromEntries(
      Object.entries(state.splitMinutes).filter(([index]) => !deletedIndexes.has(Number(index))),
    ),
  };
}
