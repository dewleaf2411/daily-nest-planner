export type Priority = "high" | "medium" | "low";
export type DueCategory = "overdue" | "today" | "tomorrow" | "future" | "none";
export type SuggestedDay = "today" | "tomorrow";

export interface PlanItem {
  originalIndex: number;
  title: string;
  durationMinutes: number;
  priority: Priority;
  /** Explicit language says this task must be completed today, independent of due date. */
  requiredToday: boolean;
  reason: string;
  dueDate?: string | null;
  dueLabel?: string | null;
  dueCategory: DueCategory;
  suggestedDay: SuggestedDay;
  isFixed: boolean;
  fixedStart?: string | null;
  fixedEnd?: string | null;
  focusBlockMinutes?: number | null;
  note?: string | null;
  /** The user explicitly chose to leave a same-day item for tomorrow. */
  deferredByUser?: boolean;
  /** The task is still saved, but the user removed it from the visible Today/Tomorrow plan. */
  removedFromPlan?: boolean;
  /** The work block intentionally planned for Today, separate from total remaining task work. */
  todayDurationMinutes?: number;
  /** Work still remaining after Today's planned block; the task and due date stay unchanged. */
  remainingDurationMinutes?: number;
}

export type ScheduleEntryKind = "task" | "break" | "fixed";

export interface ScheduleEntry {
  id: string;
  itemIndex: number; // -1 for breaks
  kind: ScheduleEntryKind;
  title: string;
  startMinutes: number; // minutes from midnight
  endMinutes: number;
  blockNumber?: number;
  totalBlocks?: number;
  isFirstBlock?: boolean;
  totalDuration?: number;
  focusBlockMinutes?: number | null;
  priority?: Priority;
  dueLabel?: string | null;
  isFixed?: boolean;
}

export interface TomorrowEntry {
  itemIndex: number;
  title: string;
  remainingMinutes: number;
  priority: Priority;
  dueLabel?: string | null;
  reason?: string;
}

export type SchedulingConflict =
  | {
      type: "fixed_overlap";
      firstItemIndex: number;
      secondItemIndex: number;
      overlapStartMinutes: number;
      overlapEndMinutes: number;
    }
  | {
      type: "due_today_unfit";
      itemIndex: number;
      dueDate: string | null;
      remainingMinutes: number;
    }
  | {
      type: "required_capacity";
      affectedItemIndexes: number[];
      requiredMinutes: number;
      scheduledMinutes: number;
      missingMinutes: number;
    }
  | {
      type: "fixed_displacement";
      fixedItemIndexes: number[];
      affectedItemIndexes: number[];
      blockedMinutes: number;
    }
  | {
      type: "task_overflow";
      itemIndex: number;
      remainingMinutes: number;
    };
