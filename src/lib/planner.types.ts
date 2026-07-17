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
