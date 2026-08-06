import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Calendar, GripVertical, Pencil, ArrowUp, ArrowDown, X, AlertCircle, Leaf, Heart, Sprout, FileText, ChevronDown, ArrowRight, Coffee, ChevronUp, Loader2, Check, Trash2 } from "lucide-react";
import { planTasks } from "@/lib/planner.functions";
import type { PlanItem, Priority, ScheduleEntry, SchedulingConflict } from "@/lib/planner.types";
import { buildSchedule, computeOrder, formatDuration, minutesToTimeLabel } from "@/lib/scheduler";
import {
  getRoomMinutesNeeded,
  previewRoomAdjustment,
  previewRoomAdjustments,
  type RoomAdjustment,
} from "@/lib/full-day-flow";
import { supabase } from "@/integrations/supabase/client";
import { ProfileMenu } from "@/components/ProfileMenu";
import { WheelTimePicker } from "@/components/WheelTimePicker";
import { lovable } from "@/integrations/lovable/index";
import { deleteTaskFromPlanState } from "@/lib/task-delete";

export const Route = createFileRoute("/plan")({
  component: PlanRoute,
});

const GUEST_USED_KEY = "dailynest_guest_plan_used";
const PLAN_STORAGE_KEY = "dailynest.plan.v1";

function PlanRoute() {
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthed(!!data.session);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthed(!!session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!checked) {
    return (
      <main className="min-h-screen w-full grid place-items-center">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </main>
    );
  }

  return <DailyNest isGuest={!authed} />;
}


const PLACEHOLDER = `Just dump everything on your mind — a to-do list, a rant, half-formed thoughts. Example:

Ugh today is so much. Rent is due soon and I still haven't paid it. I need to call the dentist at some point, and there's that form due Friday. Also want to grab snacks tomorrow. I'm just tired.`;






function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDateTimeIso(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:${s}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function friendly(dueDate: string | null | undefined): { label: string | null; cat: PlanItem["dueCategory"] } {
  if (!dueDate) return { label: null, cat: "none" };
  const diff = daysBetween(todayIso(), dueDate);
  if (diff < 0) return { label: "Overdue", cat: "overdue" };
  if (diff === 0) return { label: "Due today", cat: "today" };
  if (diff === 1) return { label: "Due tomorrow", cat: "tomorrow" };
  return { label: `Due in ${diff} days`, cat: "future" };
}

function PriorityPill({ p }: { p: Priority }) {
  const label = p === "high" ? "High" : p === "medium" ? "Medium" : "Low";
  const cls =
    p === "high"
      ? "bg-priority-high text-priority-high-fg"
      : p === "medium"
        ? "bg-priority-medium text-priority-medium-fg"
        : "bg-priority-low text-priority-low-fg";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

function FixedPill() {
  return <span className="inline-flex items-center rounded-full bg-fixed text-fixed-fg px-2 py-0.5 text-xs font-medium">Fixed time</span>;
}

function OverlapPill() {
  return <span className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">Overlaps another commitment</span>;
}

function DueLabel({ label, cat }: { label: string; cat: PlanItem["dueCategory"] }) {
  const cls =
    cat === "overdue" || cat === "today"
      ? "text-priority-high-fg"
      : cat === "tomorrow"
        ? "text-priority-medium-fg"
        : "text-muted-foreground";
  return <span className={`text-xs font-medium ${cls}`}>{label}</span>;
}

interface EditForm {
  title: string;
  dueDate: string;
  durationMinutes: number;
  fixedStart: string;
  fixedEnd: string;
}

interface BreakEditForm {
  entryId: string;
  itemIndex: number;
  title: string;
  durationMinutes: number;
  startTime: string;
}

interface CrowdedProposal {
  itemIndex: number;
  needMin: number;
  availableMin: number;
}

interface FullDayFlow {
  taskIndex: number;
  stage: "notice" | "suggestions" | "choose" | "preview";
  adjustment: RoomAdjustment | RoomAdjustment[] | null;
  previewFrom: "suggestions" | "choose";
  manualTargetIndex: number | null;
  manualKeepMinutes: number;
  message: string | null;
}

interface BreakRoomFlow {
  item: PlanItem;
  sourceEntryId: string | null;
  sourceItemIndex: number;
  stage: "options" | "move-task" | "shorten-task";
  neededMinutes: number;
  startMinutes: number | null;
  shorterDurations: number[];
}

function DailyNest({ isGuest }: { isGuest: boolean }) {
  const [raw, setRaw] = useState("");

  const [guestUsed, setGuestUsed] = useState(false);
  const [showGuestCard, setShowGuestCard] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  // Voice input removed — users can use their OS/keyboard dictation to type into the textarea.


  const [availableUntil, setAvailableUntil] = useState("22:00");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [userOrder, setUserOrder] = useState<number[]>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<{ itemIndex: number; title: string } | null>(null);
  const [crowded, setCrowded] = useState<CrowdedProposal | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [planNowMinutes, setPlanNowMinutes] = useState<number | null>(null);
  const [savedCommitments, setSavedCommitments] = useState<Array<{ id: string; name: string; days_of_week: number[]; start_time: string; end_time: string; enabled: boolean }>>([]);
  const [preferredName, setPreferredName] = useState<string>("");
  const [addMode, setAddMode] = useState<null | "task" | "break">(null);
  const [addTaskForm, setAddTaskForm] = useState<{ title: string; durationMinutes: number; priority: Priority }>({ title: "", durationMinutes: 15, priority: "medium" });
  const [splitMinutes, setSplitMinutes] = useState<Record<number, number>>({});
  const [addBreakForm, setAddBreakForm] = useState<{ title: string; durationMinutes: number }>({ title: "Break", durationMinutes: 15 });
  const [editingBreak, setEditingBreak] = useState<BreakEditForm | null>(null);
  const [openBreakActions, setOpenBreakActions] = useState<string | null>(null);
  const [suppressedBreakIds, setSuppressedBreakIds] = useState<string[]>([]);
  const [breakRoomFlow, setBreakRoomFlow] = useState<BreakRoomFlow | null>(null);
  const historyRef = useRef<{ items: PlanItem[]; order: number[]; availableUntil: string; suppressedBreakIds: string[] } | null>(null);
  const [completedTasks, setCompletedTasks] = useState<Set<number>>(new Set());
  const [undoIdx, setUndoIdx] = useState<number | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const [confirmNewPlan, setConfirmNewPlan] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showAffectedTasks, setShowAffectedTasks] = useState(false);
  const [fullDayFlow, setFullDayFlow] = useState<FullDayFlow | null>(null);
  const hydratedRef = useRef(false);
  const presentedConflictKeyRef = useRef("");
  const stopTimeControlRef = useRef<HTMLDivElement | null>(null);
  const toggleComplete = useCallback((idx: number) => {
    setCompletedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
        setUndoIdx((x) => (x === idx ? null : x));
      } else {
        next.add(idx);
        setUndoIdx(idx);
        if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = window.setTimeout(
          () => setUndoIdx((x) => (x === idx ? null : x)),
          5000,
        );
      }
      return next;
    });
  }, []);
  const undoComplete = useCallback(() => {
    setCompletedTasks((prev) => {
      if (undoIdx === null) return prev;
      const next = new Set(prev);
      next.delete(undoIdx);
      return next;
    });
    setUndoIdx(null);
  }, [undoIdx]);

  const plan = useServerFn(planTasks);

  // Guest trial state from localStorage
  useEffect(() => {
    if (!isGuest) { setGuestUsed(false); return; }
    try { setGuestUsed(localStorage.getItem(GUEST_USED_KEY) === "1"); } catch { /* ignore */ }
  }, [isGuest]);

  // Load user defaults and commitments once (signed-in only)
  useEffect(() => {
    if (isGuest) return;
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const u = userData.user;
      if (!u) return;
      const uid = u.id;
      const [{ data: p }, { data: c }] = await Promise.all([
        supabase.from("profiles").select("default_available_until, display_name").eq("id", uid).maybeSingle(),
        supabase.from("fixed_commitments").select("*").eq("user_id", uid).eq("enabled", true),
      ]);
      if (p?.default_available_until) setAvailableUntil(p.default_available_until as string);
      const preferred = (p?.display_name as string | null | undefined)?.trim();
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      const fallback =
        (meta.full_name as string) || (meta.name as string) || u.email?.split("@")[0] || "";
      const finalName = preferred && preferred.length > 0 ? preferred : fallback;
      // Use just the first name for a friendlier greeting.
      setPreferredName(finalName.split(/\s+/)[0] ?? "");
      setSavedCommitments((c ?? []) as unknown as typeof savedCommitments);
    })();
  }, [isGuest]);

  // Restore saved plan from localStorage on mount
  useEffect(() => {
    try {
      const rawSaved = localStorage.getItem(PLAN_STORAGE_KEY);
      if (rawSaved) {
        const parsed = JSON.parse(rawSaved) as {
          raw?: string;
          items?: PlanItem[];
          userOrder?: number[];
          availableUntil?: string;
          completedTasks?: number[];
          usedFallback?: boolean;
          planNowMinutes?: number | null;
          suppressedBreakIds?: string[];
        };
        if (Array.isArray(parsed.items) && parsed.items.length > 0) {
          setItems(
            parsed.items.map((item) =>
              item.reason === "Manual break" && item.itemType !== "break"
                ? { ...item, itemType: "break", isFixed: false, breakLocked: false }
                : item,
            ),
          );
        }
        if (Array.isArray(parsed.userOrder)) setUserOrder(parsed.userOrder);
        if (typeof parsed.availableUntil === "string") setAvailableUntil(parsed.availableUntil);
        if (Array.isArray(parsed.completedTasks)) setCompletedTasks(new Set(parsed.completedTasks));
        if (typeof parsed.raw === "string") setRaw(parsed.raw);
        if (typeof parsed.usedFallback === "boolean") setUsedFallback(parsed.usedFallback);
        if (typeof parsed.planNowMinutes === "number") setPlanNowMinutes(parsed.planNowMinutes);
        if (Array.isArray(parsed.suppressedBreakIds)) setSuppressedBreakIds(parsed.suppressedBreakIds);
      }
    } catch { /* ignore */ }
    hydratedRef.current = true;
  }, []);

  // Persist the current plan to localStorage whenever it changes
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!items) return;
    try {
      localStorage.setItem(
        PLAN_STORAGE_KEY,
        JSON.stringify({
          raw,
          items,
          userOrder,
          availableUntil,
          completedTasks: Array.from(completedTasks),
          usedFallback,
          planNowMinutes,
          suppressedBreakIds,
        }),
      );
    } catch { /* ignore */ }
  }, [items, userOrder, availableUntil, completedTasks, raw, usedFallback, planNowMinutes, suppressedBreakIds]);

  const startNewPlan = useCallback(() => {
    setItems(null);
    setUserOrder([]);
    setCompletedTasks(new Set());
    setRaw("");
    setUsedFallback(false);
    setPlanNowMinutes(null);
    setEditingIdx(null);
    setEditForm(null);
    setDeleteTaskTarget(null);
    setUndoIdx(null);
    setStatus(null);
    setError(null);
    setShowConflictModal(false);
    setFullDayFlow(null);
    setEditingBreak(null);
    setOpenBreakActions(null);
    setSuppressedBreakIds([]);
    setBreakRoomFlow(null);
    presentedConflictKeyRef.current = "";
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    try { localStorage.removeItem(PLAN_STORAGE_KEY); } catch { /* ignore */ }
    setConfirmNewPlan(false);
  }, []);




  const liveNowMinutes = useMemo(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }, [items]); // recompute when items change (rebuild triggers)
  const nowMinutes = planNowMinutes ?? liveNowMinutes;

  const cutoffMinutes = hhmmToMinutes(availableUntil);

  const order = useMemo(() => (items ? computeOrder(items, userOrder) : []), [items, userOrder]);

  const { schedule, tomorrow, conflicts, scheduledMinutes } = useMemo(() => {
    if (!items) return { schedule: [], tomorrow: [], conflicts: [], scheduledMinutes: 0 };
    return buildSchedule({ items, order, nowMinutes, cutoffMinutes, suppressedBreakIds });
  }, [items, order, nowMinutes, cutoffMinutes, suppressedBreakIds]);

  const roomContext = useMemo(
    () =>
      items && fullDayFlow
        ? { items, order, newTaskIndex: fullDayFlow.taskIndex, nowMinutes, cutoffMinutes }
        : null,
    [cutoffMinutes, fullDayFlow, items, nowMinutes, order],
  );
  const roomPreview = useMemo(
    () =>
      roomContext && fullDayFlow?.adjustment
        ? Array.isArray(fullDayFlow.adjustment)
          ? previewRoomAdjustments(roomContext, fullDayFlow.adjustment)
          : previewRoomAdjustment(roomContext, fullDayFlow.adjustment)
        : null,
    [fullDayFlow?.adjustment, roomContext],
  );

  useEffect(() => {
    if (
      !items ||
      loading ||
      conflicts.length === 0 ||
      crowded ||
      fullDayFlow ||
      showGuestCard ||
      confirmNewPlan ||
      presentedConflictKeyRef.current === "shown"
    ) {
      return;
    }
    presentedConflictKeyRef.current = "shown";
    setShowConflictModal(true);
  }, [conflicts.length, confirmNewPlan, crowded, fullDayFlow, items, loading, showGuestCard]);

  const pushHistory = () => {
    if (items) historyRef.current = { items: items.map((i) => ({ ...i })), order: [...order], availableUntil, suppressedBreakIds: [...suppressedBreakIds] };
  };

  const flashStatus = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((s) => (s === msg ? null : s)), 3500);
  };

  const onSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    const brainDump = raw.trim();
    if (!brainDump) {
      setError("Type or record what's on your mind, then make your plan.");
      return;
    }
    if (isGuest && guestUsed) {
      setShowGuestCard(true);
      return;
    }
    setLoading(true);
    try {
      const submittedAt = new Date();
      const res = await plan({
        data: {
          brainDump,
          nowLocalIso: localDateTimeIso(submittedAt),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          availableUntil,
        },
      });
      setPlanNowMinutes(submittedAt.getHours() * 60 + submittedAt.getMinutes());
      setPlanNowMinutes(submittedAt.getHours() * 60 + submittedAt.getMinutes());

      // Inject enabled fixed commitments for today as locked items
      const todayDow = new Date().getDay();
      const nextIdx = res.items.reduce((m, it) => Math.max(m, it.originalIndex), -1) + 1;
      const commitmentItems: PlanItem[] = savedCommitments
        .filter((c) => c.enabled && c.days_of_week.includes(todayDow))
        .map((c, i) => {
          const [sh, sm] = c.start_time.split(":").map((n) => parseInt(n, 10));
          const [eh, em] = c.end_time.split(":").map((n) => parseInt(n, 10));
          const duration = Math.max(5, (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0)));
          return {
            originalIndex: nextIdx + i,
            title: c.name,
            durationMinutes: duration,
            priority: "high",
            requiredToday: false,
            reason: "Weekly commitment",
            dueDate: null,
            dueLabel: null,
            dueCategory: "none",
            suggestedDay: "today",
            isFixed: true,
            fixedStart: c.start_time,
            fixedEnd: c.end_time,
            focusBlockMinutes: null,
            note: null,
          };
        });
      setShowConflictModal(false);
      presentedConflictKeyRef.current = "";
      setItems([...res.items, ...commitmentItems]);
      setUserOrder([]);
      setUsedFallback(res.usedFallback);
      if (isGuest) {
        try { localStorage.setItem(GUEST_USED_KEY, "1"); } catch { /* ignore */ }
        setGuestUsed(true);
        setShowGuestCard(true);
      }
    } catch (err) {
      console.error(err);
      setError("Something went wrong while making your plan. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [raw, availableUntil, plan, savedCommitments, isGuest, guestUsed]);

  const onGuestGoogle = useCallback(async () => {
    setOauthLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin + "/plan",
      });
      if (result.error) {
        setError(result.error.message || "Sign in failed. Please try again.");
        setOauthLoading(false);
        return;
      }
      if (result.redirected) return;
      setShowGuestCard(false);
      setOauthLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
      setOauthLoading(false);
    }
  }, []);






  const updateItems = (updater: (prev: PlanItem[]) => PlanItem[]) => {
    setItems((prev) => (prev ? updater(prev) : prev));
  };

  const startEdit = (idx: number) => {
    const it = items?.find((i) => i.originalIndex === idx);
    if (!it) return;
    setEditingIdx(idx);
    setEditForm({
      title: it.title,
      dueDate: it.dueDate ?? "",
      durationMinutes: it.durationMinutes,
      fixedStart: it.fixedStart ?? "",
      fixedEnd: it.fixedEnd ?? "",
    });
  };

  const saveEdit = () => {
    if (editingIdx === null || !editForm) return;
    const editingItem = items?.find((item) => item.originalIndex === editingIdx);
    if (
      editingItem?.isFixed &&
      (!editForm.fixedStart ||
        !editForm.fixedEnd ||
        hhmmToMinutes(editForm.fixedEnd) <= hhmmToMinutes(editForm.fixedStart))
    ) {
      flashStatus("Choose an end time after the start time.");
      return;
    }
    pushHistory();
    updateItems((prev) =>
      prev.map((it) => {
        if (it.originalIndex !== editingIdx) return it;
        const { label, cat } = friendly(editForm.dueDate || null);
        const fixedStart = it.isFixed ? editForm.fixedStart || it.fixedStart : it.fixedStart;
        const fixedEnd = it.isFixed ? editForm.fixedEnd || it.fixedEnd : it.fixedEnd;
        const fixedDuration =
          it.isFixed && fixedStart && fixedEnd
            ? Math.max(5, hhmmToMinutes(fixedEnd) - hhmmToMinutes(fixedStart))
            : null;
        const nextDuration =
          fixedDuration ?? Math.max(5, Math.round(editForm.durationMinutes / 5) * 5);
        const nextTodayDuration =
          it.todayDurationMinutes === undefined
            ? undefined
            : Math.min(it.todayDurationMinutes, nextDuration);
        return {
          ...it,
          title: editForm.title.trim() || it.title,
          dueDate: editForm.dueDate || null,
          dueLabel: label,
          dueCategory: cat,
          durationMinutes: nextDuration,
          todayDurationMinutes: nextTodayDuration,
          remainingDurationMinutes:
            nextTodayDuration === undefined
              ? undefined
              : Math.max(0, nextDuration - nextTodayDuration),
          fixedStart,
          fixedEnd,
        };
      }),
    );
    setEditingIdx(null);
    setEditForm(null);
    flashStatus("Your changes were saved and the timeline was rebuilt.");
  };

  const requestDeleteTask = (idx: number) => {
    const item = items?.find((candidate) => candidate.originalIndex === idx);
    if (!item || item.isFixed) return;
    setDeleteTaskTarget({ itemIndex: idx, title: item.title });
  };

  const confirmDeleteTask = () => {
    if (!items || !deleteTaskTarget) return;
    const next = deleteTaskFromPlanState(
      {
        items,
        userOrder,
        completedTasks,
        splitMinutes,
      },
      deleteTaskTarget.itemIndex,
    );
    setItems(next.items);
    setUserOrder(next.userOrder);
    setCompletedTasks(next.completedTasks);
    setSplitMinutes(next.splitMinutes);
    setEditingIdx(null);
    setEditForm(null);
    setDeleteTaskTarget(null);
    setCrowded(null);
    setFullDayFlow(null);
    setUndoIdx((current) =>
      current !== null && !next.items.some((item) => item.originalIndex === current)
        ? null
        : current,
    );
    historyRef.current = null;
    flashStatus("Task deleted");
  };

  const moveOrder = (idx: number, dir: -1 | 1) => {
    const cur = [...order];
    const at = cur.indexOf(idx);
    if (at < 0) return;
    const to = at + dir;
    if (to < 0 || to >= cur.length) return;
    [cur[at], cur[to]] = [cur[to], cur[at]];
    pushHistory();
    setUserOrder(cur);
    flashStatus("Your order was kept and the timeline was rebuilt.");
  };

  const moveToTomorrow = (idx: number) => {
    pushHistory();
    updateItems((prev) =>
      prev.map((it) =>
        it.originalIndex === idx
          ? {
              ...it,
              suggestedDay: "tomorrow" as const,
              deferredByUser: true,
              todayDurationMinutes: 0,
              remainingDurationMinutes: it.durationMinutes,
            }
          : it,
      ),
    );
    setUserOrder((o) => o.filter((i) => i !== idx));
    setEditingIdx(null);
    flashStatus("Moved to Tomorrow.");
  };

  const requestMoveToToday = (idx: number) => {
    if (!items) return;
    const it = items.find((i) => i.originalIndex === idx);
    if (!it) return;
    const moveToday = (item: PlanItem) =>
      item.originalIndex === idx
        ? {
            ...item,
            suggestedDay: "today" as const,
            deferredByUser: false,
            todayDurationMinutes: item.durationMinutes,
            remainingDurationMinutes: 0,
          }
        : item;
    // check how much free time there is
    const test = buildSchedule({
      items: items.map(moveToday),
      order: computeOrder(
        items.map(moveToday),
        [...userOrder, idx],
      ),
      nowMinutes,
      cutoffMinutes,
    });
    const scheduledForTask = test.schedule
      .filter((entry) => entry.kind === "task" && entry.itemIndex === idx)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);
    const needMin = it.durationMinutes;
    const availableMin = Math.max(0, cutoffMinutes - Math.max(nowMinutes, 0));
    pushHistory();
    updateItems((prev) => prev.map(moveToday));
    setUserOrder((o) => [...o, idx]);
    if (scheduledForTask < it.durationMinutes) {
      flashStatus("Moved to Today — some of it may not fit before your available-until time.");
    } else {
      flashStatus("Moved to Today.");
    }

  };

  const crowdedMakeRoom = (moveIdx: number) => {
    if (!crowded) return;
    pushHistory();
    updateItems((prev) =>
      prev.map((x) => {
        if (x.originalIndex === moveIdx) return { ...x, suggestedDay: "tomorrow" as const };
        if (x.originalIndex === crowded.itemIndex) return { ...x, suggestedDay: "today" as const, deferredByUser: false };
        return x;
      }),
    );
    setUserOrder((o) => [...o.filter((i) => i !== moveIdx), crowded.itemIndex]);
    setCrowded(null);
    flashStatus("Made room and rebuilt the timeline.");
  };

  const crowdedSplitToTomorrow = (moveIdx: number, splitMin: number) => {
    if (!crowded || !items) return;
    const src = items.find((i) => i.originalIndex === moveIdx);
    if (!src) return;
    const rounded = Math.max(5, Math.round(splitMin / 5) * 5);
    if (rounded >= src.durationMinutes) {
      crowdedMakeRoom(moveIdx);
      return;
    }
    const newIdx = nextIndex();
    pushHistory();
    updateItems((prev) => {
      const mapped = prev.map((x) => {
        if (x.originalIndex === moveIdx) return { ...x, durationMinutes: x.durationMinutes - rounded };
        if (x.originalIndex === crowded.itemIndex) return { ...x, suggestedDay: "today" as const, deferredByUser: false };
        return x;
      });
      const spillover: PlanItem & { parentTaskIndex: number } = {
        ...src,
        originalIndex: newIdx,
        parentTaskIndex:
          (src as PlanItem & { parentTaskIndex?: number }).parentTaskIndex ?? src.originalIndex,

        durationMinutes: rounded,
        suggestedDay: "tomorrow" as const,
        isFixed: false,
        fixedStart: null,
        fixedEnd: null,
        reason: "Split from today",
      };
      return [...mapped, spillover];
    });
    setUserOrder((o) => [...o, crowded.itemIndex]);
    setCrowded(null);
    flashStatus(`Moved ${formatDuration(rounded)} of "${src.title}" to tomorrow.`);
  };

  const crowdedExtend = () => {
    if (!crowded) return;
    const needExtraMin = crowded.needMin - crowded.availableMin;
    const capMin = 3 * 60;
    const extra = Math.min(needExtraMin, capMin);
    const newCutoff = Math.min(cutoffMinutes + extra, 23 * 60 + 59);
    const h = Math.floor(newCutoff / 60);
    const m = newCutoff % 60;
    pushHistory();
    setAvailableUntil(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    updateItems((prev) => prev.map((x) => (x.originalIndex === crowded.itemIndex ? { ...x, suggestedDay: "today" as const, deferredByUser: false } : x)));
    setUserOrder((o) => [...o, crowded.itemIndex]);
    setCrowded(null);
    flashStatus("Extended your available time and added the task.");
  };

  const crowdedDoPart = () => {
    if (!crowded) return;
    pushHistory();
    updateItems((prev) => prev.map((x) => (x.originalIndex === crowded.itemIndex ? { ...x, suggestedDay: "today" as const, deferredByUser: false } : x)));
    setUserOrder((o) => [...o, crowded.itemIndex]);
    setCrowded(null);
    flashStatus("Placed as much as fits today; the remaining time stays flagged.");
  };

  const undo = () => {
    if (!historyRef.current) return;
    setItems(historyRef.current.items);
    setUserOrder(historyRef.current.order);
    setAvailableUntil(historyRef.current.availableUntil);
    setSuppressedBreakIds(historyRef.current.suppressedBreakIds);
    historyRef.current = null;
    setCrowded(null);
    flashStatus("Restored the previous plan.");
  };

  const nextIndex = () => (items ? items.reduce((m, i) => Math.max(m, i.originalIndex), -1) + 1 : 0);

  const openAddTask = () => {
    setAddTaskForm({ title: "", durationMinutes: 15, priority: "medium" });
    setAddMode("task");
  };

  const openAddBreak = () => {
    setAddBreakForm({ title: "Break", durationMinutes: 15 });
    setAddMode("break");
  };

  const submitAddTask = () => {
    const title = addTaskForm.title.trim();
    if (!title) return;
    const duration = Math.max(5, Math.round(addTaskForm.durationMinutes / 5) * 5);
    pushHistory();
    const idx = nextIndex();
    const newItem: PlanItem = {
      originalIndex: idx,
      title,
      durationMinutes: duration,
      priority: addTaskForm.priority,
      requiredToday: false,
      reason: "Added manually",
      dueDate: null,
      dueLabel: null,
      dueCategory: "none",
      suggestedDay: "today",
      isFixed: false,
      fixedStart: null,
      fixedEnd: null,
      focusBlockMinutes: null,
      note: null,
    };
    const nextItems = items ? [...items, newItem] : [newItem];
    const nextOrder = [...userOrder, idx];
    // Test whether the new task fully fits before the cutoff.
    const test = buildSchedule({
      items: nextItems,
      order: computeOrder(nextItems, nextOrder),
      nowMinutes,
      cutoffMinutes,
    });
    const scheduledForTask = test.schedule
      .filter((entry) => entry.kind === "task" && entry.itemIndex === idx)
      .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0);

    setAddMode(null);

    if (scheduledForTask < duration) {
      const tomorrowItem = { ...newItem, suggestedDay: "tomorrow" as const, deferredByUser: true };
      setItems(items ? [...items, tomorrowItem] : [tomorrowItem]);
      setUserOrder(userOrder);
      setFullDayFlow({
        taskIndex: idx,
        stage: "notice",
        adjustment: null,
        previewFrom: "suggestions",
        manualTargetIndex: null,
        manualKeepMinutes: 15,
        message: null,
      });
    } else {
      setItems(nextItems);
      setUserOrder(nextOrder);
      flashStatus("Task added.");
    }

  };

  const closeFullDayFlow = () => setFullDayFlow(null);

  const undoFullDayPlacement = () => {
    setFullDayFlow(null);
    undo();
  };

  const selectRoomAdjustment = (
    adjustment: RoomAdjustment | RoomAdjustment[],
    from: "suggestions" | "choose",
  ) => {
    if (!roomContext) return;
    const preview = Array.isArray(adjustment)
      ? previewRoomAdjustments(roomContext, adjustment)
      : previewRoomAdjustment(roomContext, adjustment);
    if (!preview) {
      setFullDayFlow((current) =>
        current
          ? {
              ...current,
              message:
                !Array.isArray(adjustment) && adjustment.kind === "shorten"
                  ? "Enter a whole number of minutes greater than zero and lower than the task’s current planned time."
                  : "That task can’t be adjusted. Choose another flexible task.",
            }
          : current,
      );
      return;
    }
    setFullDayFlow((current) =>
      current
        ? { ...current, stage: "preview", adjustment, previewFrom: from, message: null }
        : current,
    );
  };

  const applyRoomPreview = (preview = roomPreview) => {
    if (!preview?.enoughRoom) return;
    pushHistory();
    setItems(preview.items);
    setUserOrder(preview.order);
    if (preview.cutoffMinutes !== cutoffMinutes) {
      const hours = Math.floor(preview.cutoffMinutes / 60);
      const minutes = preview.cutoffMinutes % 60;
      setAvailableUntil(`${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`);
    }
    setFullDayFlow(null);
    flashStatus("Your plan was updated.");
  };

  const timeValue = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  const scheduledTaskMinutesByItem = (entries: ScheduleEntry[]) => {
    const totals = new Map<number, number>();
    for (const entry of entries) {
      if (entry.kind !== "task") continue;
      totals.set(
        entry.itemIndex,
        (totals.get(entry.itemIndex) ?? 0) + entry.endMinutes - entry.startMinutes,
      );
    }
    return totals;
  };

  const itemsWithBreak = (baseItems: PlanItem[], breakItem: PlanItem) => {
    const exists = baseItems.some((item) => item.originalIndex === breakItem.originalIndex);
    return exists
      ? baseItems.map((item) =>
          item.originalIndex === breakItem.originalIndex ? breakItem : item,
        )
      : [...baseItems, breakItem];
  };

  const previewBreakAt = (
    breakItem: PlanItem,
    sourceEntryId: string | null,
    sourceItemIndex: number,
    startMinutes: number,
    previewCutoff = cutoffMinutes,
  ) => {
    if (!items) return null;
    const proposedItem = {
      ...breakItem,
      fixedStart: timeValue(startMinutes),
      fixedEnd: null,
    };
    const proposedItems = itemsWithBreak(items, proposedItem);
    const proposedSuppressed =
      sourceEntryId && sourceItemIndex < 0 && !suppressedBreakIds.includes(sourceEntryId)
        ? [...suppressedBreakIds, sourceEntryId]
        : suppressedBreakIds;
    const result = buildSchedule({
      items: proposedItems,
      order: computeOrder(proposedItems, userOrder),
      nowMinutes,
      cutoffMinutes: previewCutoff,
      suppressedBreakIds: proposedSuppressed,
    });
    const visibleBreak = result.schedule.find(
      (entry) => entry.kind === "break" && entry.itemIndex === proposedItem.originalIndex,
    );
    const hasBreakOverlap = result.conflicts.some(
      (conflict) =>
        conflict.type === "break_overlap" &&
        conflict.breakItemIndex === proposedItem.originalIndex,
    );
    if (
      !visibleBreak ||
      visibleBreak.endMinutes - visibleBreak.startMinutes < proposedItem.durationMinutes ||
      hasBreakOverlap
    ) {
      return null;
    }
    const baselineTotals = scheduledTaskMinutesByItem(schedule);
    const previewTotals = scheduledTaskMinutesByItem(result.schedule);
    const neededMinutes = [...baselineTotals.entries()].reduce(
      (total, [itemIndex, baselineMinutes]) =>
        total + Math.max(0, baselineMinutes - (previewTotals.get(itemIndex) ?? 0)),
      0,
    );
    return { item: proposedItem, result, neededMinutes };
  };

  const chooseBreakPlacement = (
    breakItem: PlanItem,
    sourceEntryId: string | null,
    sourceItemIndex: number,
    preferredStart?: number,
  ) => {
    const duration = breakItem.durationMinutes;
    const blockingEntries = schedule.filter(
      (entry) =>
        entry.id !== sourceEntryId &&
        (entry.kind === "fixed" ||
          (entry.kind === "break" && !entry.id.startsWith("gap-"))),
    );
    const isSafeInterval = (start: number) =>
      start >= nowMinutes &&
      start + duration <= cutoffMinutes &&
      !blockingEntries.some(
        (entry) => entry.startMinutes < start + duration && entry.endMinutes > start,
      );
    const roundedPreferred =
      preferredStart === undefined ? null : Math.ceil(preferredStart / 5) * 5;
    if (roundedPreferred !== null && isSafeInterval(roundedPreferred)) {
      const preview = previewBreakAt(
        breakItem,
        sourceEntryId,
        sourceItemIndex,
        roundedPreferred,
      );
      if (preview) return { startMinutes: roundedPreferred, ...preview };
    }

    const candidates = new Set<number>([
      Math.ceil(nowMinutes / 5) * 5,
      Math.max(nowMinutes, cutoffMinutes - duration),
    ]);
    for (const entry of schedule) {
      if (entry.id === sourceEntryId) continue;
      candidates.add(Math.ceil(entry.startMinutes / 5) * 5);
      candidates.add(Math.ceil(entry.endMinutes / 5) * 5);
    }
    const previews = [...candidates]
      .filter(isSafeInterval)
      .map((startMinutes) => {
        const preview = previewBreakAt(
          breakItem,
          sourceEntryId,
          sourceItemIndex,
          startMinutes,
        );
        return preview ? { startMinutes, ...preview } : null;
      })
      .filter(
        (
          candidate,
        ): candidate is NonNullable<typeof candidate> => candidate !== null,
      )
      .sort(
        (first, second) =>
          first.neededMinutes - second.neededMinutes ||
          first.startMinutes - second.startMinutes,
      );
    return previews[0] ?? null;
  };

  const shorterBreakDurations = (
    breakItem: PlanItem,
    sourceEntryId: string | null,
    sourceItemIndex: number,
  ) => {
    const options: number[] = [];
    for (let duration = breakItem.durationMinutes - 5; duration >= 5; duration -= 5) {
      const placement = chooseBreakPlacement(
        { ...breakItem, durationMinutes: duration },
        sourceEntryId,
        sourceItemIndex,
      );
      if (placement?.neededMinutes === 0) options.push(duration);
      if (options.length === 3) break;
    }
    return options;
  };

  const commitBreakPlacement = (
    flow: BreakRoomFlow,
    baseItems = items,
    nextCutoffMinutes = cutoffMinutes,
  ) => {
    if (!baseItems) return;
    const startMinutes = flow.startMinutes ?? cutoffMinutes;
    const placedItem = {
      ...flow.item,
      fixedStart: timeValue(startMinutes),
      fixedEnd: null,
    };
    pushHistory();
    setItems(itemsWithBreak(baseItems, placedItem));
    if (
      flow.sourceEntryId &&
      flow.sourceItemIndex < 0 &&
      !suppressedBreakIds.includes(flow.sourceEntryId)
    ) {
      setSuppressedBreakIds((current) => [...current, flow.sourceEntryId!]);
    }
    if (nextCutoffMinutes !== cutoffMinutes) {
      setAvailableUntil(timeValue(nextCutoffMinutes));
    }
    setBreakRoomFlow(null);
    setAddMode(null);
    setEditingBreak(null);
    setOpenBreakActions(null);
    setShowConflictModal(false);
    presentedConflictKeyRef.current = "";
    flashStatus("Break added and the timeline was rebuilt.");
  };

  const requestBreakPlacement = (
    breakItem: PlanItem,
    sourceEntryId: string | null,
    sourceItemIndex: number,
    preferredStart?: number,
  ) => {
    const placement = chooseBreakPlacement(
      breakItem,
      sourceEntryId,
      sourceItemIndex,
      preferredStart,
    );
    const flow: BreakRoomFlow = {
      item: placement?.item ?? breakItem,
      sourceEntryId,
      sourceItemIndex,
      stage: "options",
      neededMinutes: placement?.neededMinutes ?? breakItem.durationMinutes,
      startMinutes: placement?.startMinutes ?? null,
      shorterDurations: shorterBreakDurations(
        breakItem,
        sourceEntryId,
        sourceItemIndex,
      ),
    };
    if (placement && placement.neededMinutes === 0) {
      commitBreakPlacement(flow);
      return;
    }
    setAddMode(null);
    setEditingBreak(null);
    setOpenBreakActions(null);
    setShowConflictModal(false);
    setBreakRoomFlow(flow);
  };

  const submitAddBreak = () => {
    const duration = Math.max(5, Math.round(addBreakForm.durationMinutes / 5) * 5);
    const newItem: PlanItem = {
      originalIndex: nextIndex(),
      itemType: "break",
      title: addBreakForm.title.trim() || "Break",
      durationMinutes: duration,
      priority: "low",
      requiredToday: false,
      reason: "Manual break",
      dueDate: null,
      dueLabel: null,
      dueCategory: "none",
      suggestedDay: "today",
      isFixed: false,
      fixedStart: null,
      fixedEnd: null,
      focusBlockMinutes: null,
      note: null,
      breakLocked: false,
    };
    requestBreakPlacement(newItem, null, -1);
  };

  const beginBreakEdit = (entry: ScheduleEntry) => {
    setEditingBreak({
      entryId: entry.id,
      itemIndex: entry.itemIndex,
      title: entry.title,
      durationMinutes: entry.endMinutes - entry.startMinutes,
      startTime: timeValue(entry.startMinutes),
    });
    setOpenBreakActions(entry.id);
  };

  const saveBreakEdit = () => {
    if (!editingBreak || !items) return;
    const duration = Math.max(5, Math.round(editingBreak.durationMinutes / 5) * 5);
    const startMinutes = hhmmToMinutes(editingBreak.startTime);
    const title = editingBreak.title.trim() || "Break";
    if (editingBreak.itemIndex >= 0) {
      const existing = items.find(
        (item) => item.originalIndex === editingBreak.itemIndex,
      );
      if (!existing) return;
      requestBreakPlacement(
        {
          ...existing,
          itemType: "break",
          title,
          durationMinutes: duration,
          isFixed: false,
          fixedStart: editingBreak.startTime,
          fixedEnd: null,
        },
        editingBreak.entryId,
        editingBreak.itemIndex,
        startMinutes,
      );
    } else {
      const newBreak: PlanItem = {
        originalIndex: nextIndex(),
        itemType: "break",
        title,
        durationMinutes: duration,
        priority: "low",
        requiredToday: false,
        reason: "Edited generated break",
        dueDate: null,
        dueLabel: null,
        dueCategory: "none",
        suggestedDay: "today",
        isFixed: false,
        fixedStart: editingBreak.startTime,
        fixedEnd: null,
        focusBlockMinutes: null,
        note: null,
        breakLocked: false,
      };
      requestBreakPlacement(
        newBreak,
        editingBreak.entryId,
        -1,
        startMinutes,
      );
    }
  };

  const deleteBreak = (entry: ScheduleEntry) => {
    pushHistory();
    if (entry.itemIndex >= 0) {
      updateItems((prev) => prev.filter((item) => item.originalIndex !== entry.itemIndex));
    } else {
      setSuppressedBreakIds((current) =>
        current.includes(entry.id) ? current : [...current, entry.id],
      );
    }
    setEditingBreak(null);
    setOpenBreakActions(null);
    flashStatus("Break removed and the timeline was rebuilt.");
  };

  const relocateBreak = (entry: ScheduleEntry, requestedStart: number) => {
    if (!items) return;
    const duration = entry.endMinutes - entry.startMinutes;
    if (entry.itemIndex >= 0) {
      const existing = items.find((item) => item.originalIndex === entry.itemIndex);
      if (!existing) return;
      requestBreakPlacement(
        { ...existing, itemType: "break", isFixed: false, fixedEnd: null },
        entry.id,
        entry.itemIndex,
        requestedStart,
      );
    } else {
      requestBreakPlacement(
        {
          originalIndex: nextIndex(),
          itemType: "break",
          title: entry.title,
          durationMinutes: duration,
          priority: "low",
          requiredToday: false,
          reason: "Moved generated break",
          dueDate: null,
          dueLabel: null,
          dueCategory: "none",
          suggestedDay: "today",
          isFixed: false,
          fixedStart: null,
          fixedEnd: null,
          focusBlockMinutes: null,
          note: null,
          breakLocked: false,
        },
        entry.id,
        -1,
        requestedStart,
      );
    }
  };

  const movableTasksForBreak = breakRoomFlow && breakRoomFlow.startMinutes !== null && items
    ? items
        .filter(
          (item) =>
            item.itemType !== "break" &&
            !item.isFixed &&
            !item.removedFromPlan &&
            item.suggestedDay === "today",
        )
        .map((item) => ({
          item,
          plannedMinutes: item.todayDurationMinutes ?? item.durationMinutes,
          scheduledMinutes: schedule
            .filter(
              (entry) =>
                entry.kind === "task" && entry.itemIndex === item.originalIndex,
            )
            .reduce(
              (total, entry) => total + entry.endMinutes - entry.startMinutes,
              0,
            ),
        }))
        .filter(
          ({ scheduledMinutes, plannedMinutes }) =>
            scheduledMinutes === plannedMinutes &&
            scheduledMinutes >= breakRoomFlow.neededMinutes,
        )
    : [];

  const applyBreakTaskChoice = (itemIndex: number) => {
    if (!breakRoomFlow || !items) return;
    const requiredMinutes = breakRoomFlow.neededMinutes;
    const adjustedItems = items.map((item) => {
      if (item.originalIndex !== itemIndex) return item;
      const currentTodayMinutes =
        item.todayDurationMinutes ?? item.durationMinutes;
      const movedMinutes = Math.min(requiredMinutes, currentTodayMinutes);
      const nextTodayMinutes = Math.max(0, currentTodayMinutes - movedMinutes);
      return {
        ...item,
        suggestedDay: nextTodayMinutes === 0 ? ("tomorrow" as const) : item.suggestedDay,
        deferredByUser: nextTodayMinutes === 0 ? true : item.deferredByUser,
        todayDurationMinutes: nextTodayMinutes,
        remainingDurationMinutes:
          (item.remainingDurationMinutes ?? 0) + movedMinutes,
      };
    });
    commitBreakPlacement(breakRoomFlow, adjustedItems);
  };

  const extendForBreak = () => {
    if (!breakRoomFlow) return;
    const nextCutoff = cutoffMinutes + breakRoomFlow.neededMinutes;
    if (nextCutoff > 23 * 60 + 59) return;
    commitBreakPlacement(breakRoomFlow, items, nextCutoff);
  };

  const selectShorterBreak = (durationMinutes: number) => {
    if (!breakRoomFlow) return;
    const shorterItem = { ...breakRoomFlow.item, durationMinutes };
    const placement = chooseBreakPlacement(
      shorterItem,
      breakRoomFlow.sourceEntryId,
      breakRoomFlow.sourceItemIndex,
    );
    if (!placement || placement.neededMinutes > 0) return;
    commitBreakPlacement({
      ...breakRoomFlow,
      item: placement.item,
      neededMinutes: 0,
      startMinutes: placement.startMinutes,
      shorterDurations: [],
    });
  };

  const skipPendingBreak = () => {
    if (!breakRoomFlow || !items) return;
    if (breakRoomFlow.sourceItemIndex >= 0) {
      pushHistory();
      setItems(
        items.filter(
          (item) => item.originalIndex !== breakRoomFlow.sourceItemIndex,
        ),
      );
    } else if (breakRoomFlow.sourceEntryId) {
      pushHistory();
      setSuppressedBreakIds((current) =>
        current.includes(breakRoomFlow.sourceEntryId!)
          ? current
          : [...current, breakRoomFlow.sourceEntryId!],
      );
    }
    setBreakRoomFlow(null);
    setEditingBreak(null);
    setOpenBreakActions(null);
    flashStatus("Break skipped.");
  };



  // Drag-and-drop for flexible today tasks and breaks
  const dragIdxRef = useRef<number | null>(null);
  const dragBreakRef = useRef<ScheduleEntry | null>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const [dropPos, setDropPos] = useState<number | null>(null);
  const endDrag = () => {
    dragIdxRef.current = null;
    dragBreakRef.current = null;
    setIsDraggingCard(false);
    setDropPos(null);
  };
  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    dragBreakRef.current = null;
    dragIdxRef.current = idx;
    setIsDraggingCard(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };
  const onBreakDragStart = (entry: ScheduleEntry) => (e: React.DragEvent) => {
    dragIdxRef.current = null;
    dragBreakRef.current = entry;
    setIsDraggingCard(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.id);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onZoneDragOver = (pos: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropPos((current) => (current === pos ? current : pos));
  };
  // Drop into the gap at position `pos` (0 = before the first card)
  const onDropAtPosition = (pos: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const brk = dragBreakRef.current;
    const src = dragIdxRef.current;
    endDrag();

    if (brk) {
      const after = scheduleWithMeta
        .slice(pos)
        .find((m) => m.entry.id !== brk.id);
      const before = [...scheduleWithMeta.slice(0, pos)]
        .reverse()
        .find((m) => m.entry.id !== brk.id);
      const startMinutes = after
        ? after.entry.startMinutes
        : before
          ? before.entry.endMinutes
          : brk.startMinutes;
      if (startMinutes !== brk.startMinutes) relocateBreak(brk, startMinutes);
      return;
    }

    if (src === null) return;
    const cur = [...order];
    const from = cur.indexOf(src);
    if (from < 0) return;
    let targetIdx: number | null = null;
    for (let i = pos; i < scheduleWithMeta.length; i++) {
      const m = scheduleWithMeta[i];
      if (m.entry.kind === "task" && m.item && m.item.originalIndex !== src) {
        targetIdx = m.item.originalIndex;
        break;
      }
    }
    cur.splice(from, 1);
    const to = targetIdx === null ? cur.length : cur.indexOf(targetIdx);
    if (to < 0) return;
    cur.splice(to, 0, src);
    if (cur.every((value, index) => value === order[index])) return;
    pushHistory();
    setUserOrder(cur);
    flashStatus("Your order was kept and the timeline was rebuilt.");
  };
  // Dropping directly on a card = drop just before that card
  const onDropOnCard = (pos: number) => (e: React.DragEvent) => {
    onDropAtPosition(pos)(e);
  };
  const renderDropZone = (pos: number) => (
    <li
      key={`drop-zone-${pos}`}
      aria-hidden
      onDragOver={onZoneDragOver(pos)}
      onDragLeave={() => setDropPos((current) => (current === pos ? null : current))}
      onDrop={onDropAtPosition(pos)}
      className={`relative list-none transition-all ${isDraggingCard ? "h-6 -my-2" : "h-0 pointer-events-none"}`}
    >
      {isDraggingCard && (
        <span
          className={`pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full transition-colors ${dropPos === pos ? "bg-primary" : "bg-transparent"}`}
        />
      )}
    </li>
  );

  // Group schedule entries by task to render blocks together
  const scheduleWithMeta = schedule.map((s) => {
    if (s.kind === "task" || s.kind === "break") {
      const item = items?.find((i) => i.originalIndex === s.itemIndex);
      return { entry: s, item };
    }
    if (s.kind === "fixed") {
      const item = items?.find((i) => i.originalIndex === s.itemIndex);
      return { entry: s, item };
    }
    return { entry: s, item: undefined };
  });

  const cutoffLabel = minutesToTimeLabel(cutoffMinutes);
  const overlapConflicts = conflicts.filter(
    (conflict): conflict is Extract<SchedulingConflict, { type: "fixed_overlap" }> =>
      conflict.type === "fixed_overlap",
  );
  const breakConflicts = conflicts.filter(
    (conflict): conflict is Extract<SchedulingConflict, { type: "break_overlap" }> =>
      conflict.type === "break_overlap",
  );
  const dueTodayConflicts = conflicts.filter(
    (conflict): conflict is Extract<SchedulingConflict, { type: "due_today_unfit" }> =>
      conflict.type === "due_today_unfit",
  );
  const capacityConflict = conflicts.find(
    (conflict): conflict is Extract<SchedulingConflict, { type: "required_capacity" }> =>
      conflict.type === "required_capacity",
  );
  const dueTodayRemaining = dueTodayConflicts.reduce(
    (total, conflict) => total + conflict.remainingMinutes,
    0,
  );
  const overflowRemaining = conflicts
    .filter((conflict): conflict is Extract<SchedulingConflict, { type: "task_overflow" }> =>
      conflict.type === "task_overflow",
    )
    .reduce((total, conflict) => total + conflict.remainingMinutes, 0);
  const overlappingFixedIndexes = new Set(
    overlapConflicts.flatMap((conflict) => [conflict.firstItemIndex, conflict.secondItemIndex]),
  );
  const firstAffectedItemIndex = (() => {
    const overlap = overlapConflicts[0];
    if (overlap) return overlap.firstItemIndex;
    const dueToday = dueTodayConflicts[0];
    if (dueToday) return dueToday.itemIndex;
    const capacity = capacityConflict?.affectedItemIndexes[0];
    if (capacity !== undefined) return capacity;
    const overflow = conflicts.find(
      (conflict): conflict is Extract<SchedulingConflict, { type: "task_overflow" }> =>
        conflict.type === "task_overflow",
    );
    return overflow?.itemIndex ?? null;
  })();

  const { affectedRows, totalUnfit } = useMemo(() => {
    if (!items) return { affectedRows: [], totalUnfit: 0 };
    const affectedMap = new Map<number, { title: string; minutes: number }>();
    for (const conflict of conflicts) {
      if (conflict.type === "fixed_overlap" || conflict.type === "break_overlap") continue;
      if (conflict.type === "due_today_unfit" || conflict.type === "task_overflow") {
        const item = items.find((i) => i.originalIndex === conflict.itemIndex);
        if (item) affectedMap.set(item.originalIndex, { title: item.title, minutes: conflict.remainingMinutes });
      } else if (conflict.type === "fixed_displacement" || conflict.type === "required_capacity") {
        for (const idx of conflict.affectedItemIndexes) {
          const item = items.find((i) => i.originalIndex === idx);
          if (item) affectedMap.set(item.originalIndex, { title: item.title, minutes: item.durationMinutes });
        }
      }
    }
    const affectedRows = Array.from(affectedMap.values());
    const totalUnfit = dueTodayRemaining + overflowRemaining + (capacityConflict?.missingMinutes ?? 0);
    return { affectedRows, totalUnfit };
  }, [items, conflicts, dueTodayRemaining, overflowRemaining, capacityConflict?.missingMinutes]);

  const scrollToItem = (itemIndex: number) => {
    window.setTimeout(() => {
      const target =
        document.getElementById(`tomorrow-item-${itemIndex}`) ??
        document.getElementById(`plan-item-${itemIndex}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  };

  const editConflictItem = (itemIndex: number) => {
    setShowConflictModal(false);
    startEdit(itemIndex);
    scrollToItem(itemIndex);
  };

  const resolveBreakConflict = (action: "move" | "shorten" | "remove") => {
    const conflict = breakConflicts[0];
    if (!conflict || !items) return;
    const breakItem = items.find((item) => item.originalIndex === conflict.breakItemIndex);
    if (!breakItem?.fixedStart) return;
    const shortenTo =
      action === "shorten"
        ? conflict.overlapStartMinutes - hhmmToMinutes(breakItem.fixedStart)
        : null;
    if (shortenTo !== null && shortenTo < 5) {
      flashStatus("There is not enough room there to shorten this break.");
      return;
    }
    pushHistory();
    if (action === "remove") {
      setItems(items.filter((item) => item.originalIndex !== breakItem.originalIndex));
    } else if (action === "shorten") {
      setItems(
        items.map((item) =>
          item.originalIndex === breakItem.originalIndex
            ? { ...item, durationMinutes: Math.floor((shortenTo ?? 5) / 5) * 5 }
            : item,
        ),
      );
    } else {
      const other = schedule.find((entry) => entry.itemIndex === conflict.otherItemIndex);
      const duration = breakItem.durationMinutes;
      const after = other ? other.endMinutes : conflict.overlapEndMinutes;
      const before = (other ? other.startMinutes : conflict.overlapStartMinutes) - duration;
      const nextStart = after + duration <= cutoffMinutes ? after : Math.max(nowMinutes, before);
      setItems(
        items.map((item) =>
          item.originalIndex === breakItem.originalIndex
            ? { ...item, fixedStart: timeValue(Math.ceil(nextStart / 5) * 5) }
            : item,
        ),
      );
    }
    setShowConflictModal(false);
    presentedConflictKeyRef.current = "";
    flashStatus(`Break ${action === "remove" ? "removed" : action === "move" ? "moved" : "shortened"} and the timeline was rebuilt.`);
  };

  const focusStopTime = () => {
    setShowConflictModal(false);
    window.setTimeout(() => {
      stopTimeControlRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      stopTimeControlRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    }, 0);
  };

  return (
    <main className="relative min-h-screen w-full overflow-hidden px-4 py-10 sm:py-16">
      {/* soft decorative leaves */}
      <div aria-hidden className="pointer-events-none absolute -left-16 top-24 hidden md:block opacity-40">
        <Leaf className="h-72 w-72 text-primary/20 -rotate-12" strokeWidth={0.6} />
      </div>
      <div aria-hidden className="pointer-events-none absolute -right-16 top-10 hidden md:block opacity-30">
        <Leaf className="h-64 w-64 text-primary/20 rotate-45" strokeWidth={0.6} />
      </div>

      <div className="relative mx-auto w-full max-w-[860px]">
        <header className="mb-8 sm:mb-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-secondary text-primary">
                <Leaf className="h-6 w-6" strokeWidth={1.5} />
              </div>
              <h1 className="font-serif text-5xl sm:text-6xl font-normal tracking-tight text-foreground leading-none">Planner</h1>
            </div>
            {isGuest ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 backdrop-blur-sm px-3 py-1.5 text-sm text-muted-foreground">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-primary text-[10px] font-medium">G</span>
                Guest
              </span>
            ) : (
              <ProfileMenu />
            )}

          </div>
          <p className="mt-4 text-sm sm:text-base text-muted-foreground">
            A calm, honest plan for today — no dashboards, no streaks.
          </p>
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Heart className="h-4 w-4 text-primary/70" strokeWidth={1.6} />
            You don't have to do it all. We'll help you focus on what matters.
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-card/90 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03),0_20px_50px_-24px_rgba(30,60,45,0.18)] p-6 sm:p-8">
          <form onSubmit={onSubmit}>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
                <FileText className="h-5 w-5" strokeWidth={1.6} />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="tasks" className="block font-serif text-2xl font-normal text-foreground leading-tight">
                  {preferredName ? `Hi ${preferredName} — type or talk everything on your mind` : "Type or talk everything on your mind"}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">Rant, list, half-thoughts — the AI pulls out what actually needs doing. Prefer to talk? Use your keyboard or system dictation!</p>
              </div>
            </div>

            <textarea
              id="tasks"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={PLACEHOLDER}
              rows={8}
              className="mt-4 w-full resize-y rounded-xl border border-input bg-background/70 px-4 py-3.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />





            <div className="my-6 h-px bg-border/70" />

            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
                <Clock className="h-5 w-5" strokeWidth={1.6} />
              </div>
              <div className="min-w-0">
                <label htmlFor="until" className="block font-serif text-2xl font-normal text-foreground leading-tight">
                  Available until
                </label>
                <p className="mt-1 text-xs text-muted-foreground">We won't schedule tasks after this time.</p>
              </div>
            </div>

            <div ref={stopTimeControlRef} className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <WheelTimePicker
                id="until"
                value={availableUntil}
                onChange={setAvailableUntil}
                ariaLabel="Available until"
                className="w-full sm:w-56"
              />
              <button
                type="submit"
                disabled={loading}
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-base font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {loading ? "Making plan…" : "Make My Plan"}
                {!loading && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.8} />}
              </button>
            </div>

            {items && !loading && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmNewPlan(true)}
                  className="inline-flex items-center rounded-md border border-border bg-background/70 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  New Plan
                </button>
              </div>
            )}

            {error && (
              <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-soft-error px-3 py-2.5 text-sm text-soft-error-fg">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </form>

          {loading && (
            <div className="mt-8 text-center text-sm text-muted-foreground">Making your plan…</div>
          )}

          {items && !loading && (
            <div className="mt-12">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-border/60 pb-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-secondary text-primary">
                    <Leaf className="h-5 w-5" strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="font-serif text-3xl sm:text-4xl font-normal leading-none text-foreground">Today</h2>
                    <p className="mt-1.5 text-xs sm:text-sm text-muted-foreground">Your plan is ready. You've got this.</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="inline-flex items-center gap-1.5 text-lg sm:text-xl font-medium text-foreground tabular-nums">
                    <Clock className="h-4 w-4 text-muted-foreground" strokeWidth={1.6} />
                    {formatDuration(scheduledMinutes)}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">scheduled before {cutoffLabel}</p>
                </div>
              </div>
              {usedFallback && (
                <p className="mt-3 text-xs text-muted-foreground">Using a local demo plan (no AI key needed).</p>
              )}

              {conflicts.length > 0 && (
                <div id="conflict-banner" className="mt-3 flex items-center justify-between gap-3 rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">
                  <div className="min-w-0 flex-1">
                    {breakConflicts.length > 0 && (
                      <span>{breakConflicts.length} break conflict{breakConflicts.length === 1 ? "" : "s"} need attention. </span>
                    )}
                    {overlapConflicts.length > 0 && (
                      <span>{overlapConflicts.length} unresolved fixed-time overlap{overlapConflicts.length === 1 ? "" : "s"}. </span>
                    )}
                    {dueTodayRemaining > 0 && (
                      <span>{formatDuration(dueTodayRemaining)} of due-today work still needs time.</span>
                    )}
                    {overlapConflicts.length === 0 && dueTodayRemaining === 0 && capacityConflict && (
                      <span>{formatDuration(capacityConflict.missingMinutes)} of required work still needs time.</span>
                    )}
                    {overlapConflicts.length === 0 && dueTodayRemaining === 0 && !capacityConflict && overflowRemaining > 0 && (
                      <span>{formatDuration(overflowRemaining)} of planned work still needs time.</span>
                    )}
                  </div>
                  {(breakConflicts.length > 0 || overlapConflicts.length > 0) && (
                    <button
                      type="button"
                      onClick={() => setShowConflictModal(true)}
                      className="shrink-0 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-background"
                    >
                      Review conflict
                    </button>
                  )}
                </div>
              )}

              {status && (
                <div className="mt-3 rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">{status}</div>
              )}

              {scheduleWithMeta.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">Nothing fits before your cutoff — review the conflict summary or Tomorrow below.</p>
              ) : (
                <ol className="mt-5 space-y-2.5">
                  {scheduleWithMeta.map(({ entry, item }, mapIndex) => {
                    if (entry.kind === "break") {
                      const isBreakEditing = editingBreak?.entryId === entry.id;
                      const actionsOpen = openBreakActions === entry.id;
                      return (
                        <Fragment key={entry.id}>
                        {renderDropZone(mapIndex)}
                        <li
                          draggable={!isBreakEditing}
                          onDragStart={onBreakDragStart(entry)}
                          onDragEnd={endDrag}
                          onDragOver={onDragOver}
                          onDrop={onDropOnCard(mapIndex)}
                          onClick={() => setOpenBreakActions((current) => current === entry.id ? null : entry.id)}
                          className="group rounded-xl border border-border/60 bg-secondary/40 px-3 py-2.5 sm:px-4"
                        >
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                            <div className="flex items-center gap-1 text-primary">
                              <GripVertical className="h-4 w-4 cursor-grab opacity-50 group-hover:opacity-80 group-focus-within:opacity-80" aria-hidden="true" />
                              <Coffee className="h-4 w-4" strokeWidth={1.5} />
                            </div>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                              <span className="font-medium text-muted-foreground tabular-nums">
                                {minutesToTimeLabel(entry.startMinutes)}–{minutesToTimeLabel(entry.endMinutes)}
                              </span>
                              <span className="truncate text-muted-foreground">{entry.title}</span>
                              {entry.isLockedBreak && <FixedPill />}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="mr-1 text-xs tabular-nums text-priority-low-fg">{formatDuration(entry.endMinutes - entry.startMinutes)}</span>
                              <div className={`flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${actionsOpen ? "opacity-100" : "max-sm:opacity-0"}`}>
                                <button type="button" onClick={(event) => { event.stopPropagation(); beginBreakEdit(entry); }} aria-label={`Edit ${entry.title}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-background/80 hover:text-foreground">
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button type="button" onClick={(event) => { event.stopPropagation(); deleteBreak(entry); }} aria-label={`Delete ${entry.title}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                          {isBreakEditing && editingBreak && (
                            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]" onClick={(event) => event.stopPropagation()}>
                              <input value={editingBreak.title} onChange={(event) => setEditingBreak({ ...editingBreak, title: event.target.value })} aria-label="Break name" className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm" />
                              <div className="w-[150px]"><WheelTimePicker value={editingBreak.startTime} onChange={(v) => setEditingBreak({ ...editingBreak, startTime: v })} ariaLabel="Break start time" /></div>
                              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                                <input type="number" min={5} step={5} value={editingBreak.durationMinutes} onChange={(event) => setEditingBreak({ ...editingBreak, durationMinutes: parseInt(event.target.value, 10) || 5 })} aria-label="Break duration in minutes" className="w-16 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" />
                                min
                              </label>
                              <div className="flex items-center justify-end gap-1">
                                <button type="button" onClick={() => setEditingBreak(null)} className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-background">Cancel</button>
                                <button type="button" onClick={saveBreakEdit} className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">Save</button>
                              </div>
                            </div>
                          )}
                        </li>
                        </Fragment>
                      );
                    }
                    const isEditing = item && editingIdx === item.originalIndex;
                    const isFlexible = entry.kind === "task";
                    return (
                      <Fragment key={entry.id}>
                      {renderDropZone(mapIndex)}
                      <li
                        id={item && (entry.kind === "fixed" || entry.isFirstBlock) ? `plan-item-${item.originalIndex}` : undefined}
                        draggable={isFlexible && !isEditing}
                        onDragStart={isFlexible && item ? onDragStart(item.originalIndex) : undefined}
                        onDragEnd={endDrag}
                        onDragOver={onDragOver}
                        onDrop={onDropOnCard(mapIndex)}
                        className={`group rounded-xl border border-border bg-card p-3 sm:p-4 transition-colors ${item && completedTasks.has(item.originalIndex) ? "bg-secondary/40 border-border/60" : ""}`}
                      >
                        <div className={`flex items-start gap-3 sm:gap-4 ${item && completedTasks.has(item.originalIndex) ? "opacity-60" : ""}`}>
                          <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                            {item ? (
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={completedTasks.has(item.originalIndex)}
                                aria-label={completedTasks.has(item.originalIndex) ? `Mark ${entry.title} not done` : `Mark ${entry.title} done`}
                                onClick={(e) => { e.stopPropagation(); toggleComplete(item.originalIndex); }}
                                className={`h-5 w-5 rounded-md border transition-colors flex items-center justify-center ${completedTasks.has(item.originalIndex) ? "bg-primary/80 border-primary/80 text-primary-foreground" : "border-border bg-background hover:border-primary/60"}`}
                              >
                                {completedTasks.has(item.originalIndex) && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                              </button>
                            ) : (
                              <div className="rounded-lg bg-secondary text-secondary-foreground w-11 h-11 flex items-center justify-center">
                                {entry.kind === "fixed" ? <Calendar className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                                {minutesToTimeLabel(entry.startMinutes)}–{minutesToTimeLabel(entry.endMinutes)}
                              </span>
                              {entry.blockNumber && entry.totalBlocks && (
                                <span className="text-xs text-muted-foreground">
                                  Block {entry.blockNumber} of {entry.totalBlocks}
                                </span>
                              )}
                              {entry.priority && <PriorityPill p={entry.priority} />}
                              {entry.isFixed && <FixedPill />}
                              {entry.isFixed && item && overlappingFixedIndexes.has(item.originalIndex) && <OverlapPill />}
                              {entry.dueLabel && entry.isFirstBlock && (
                                <DueLabel label={entry.dueLabel} cat={item?.dueCategory ?? "none"} />
                              )}
                            </div>
                            <div className={`mt-1 text-sm font-medium text-foreground truncate ${item && completedTasks.has(item.originalIndex) ? "line-through decoration-1" : ""}`}>{entry.title}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {formatDuration(entry.endMinutes - entry.startMinutes)}
                              {(item?.remainingDurationMinutes ?? 0) > 0 ? " today" : ""}
                            </div>
                            {item && isEditing && editForm && (
                              <div className="mt-3 rounded-lg border border-border bg-background/70 p-3 space-y-2">
                                <div>
                                  <label className="block text-xs font-medium text-muted-foreground">Title</label>
                                  <input
                                    value={editForm.title}
                                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                                    className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                  />
                                </div>
                                {item.isFixed && (
                                  <div className="flex flex-col gap-2 sm:flex-row">
                                    <div className="flex-1">
                                      <label className="block text-xs font-medium text-muted-foreground">Starts at</label>
                                      <WheelTimePicker
                                        value={editForm.fixedStart}
                                        onChange={(v) => setEditForm({ ...editForm, fixedStart: v })}
                                        ariaLabel="Starts at"
                                        className="mt-1"
                                      />
                                    </div>
                                    <div className="flex-1">
                                      <label className="block text-xs font-medium text-muted-foreground">Ends at</label>
                                      <WheelTimePicker
                                        value={editForm.fixedEnd}
                                        onChange={(v) => setEditForm({ ...editForm, fixedEnd: v })}
                                        ariaLabel="Ends at"
                                        className="mt-1"
                                      />

                                    </div>
                                  </div>
                                )}
                                <div className="flex flex-col sm:flex-row gap-2">
                                  <div className="flex-1">
                                    <label className="block text-xs font-medium text-muted-foreground">Due date</label>
                                    <input
                                      type="date"
                                      value={editForm.dueDate}
                                      onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })}
                                      className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                    />
                                  </div>
                                  {!item.isFixed && <div className="flex-1">
                                    <label className="block text-xs font-medium text-muted-foreground">Duration (min)</label>
                                    <input
                                      type="number"
                                      min={5}
                                      step={5}
                                      value={editForm.durationMinutes}
                                      onChange={(e) => setEditForm({ ...editForm, durationMinutes: parseInt(e.target.value, 10) || 5 })}
                                      className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                    />
                                  </div>}
                                </div>
                                <div className="flex flex-wrap gap-2 pt-1">
                                  {isFlexible && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => moveOrder(item.originalIndex, -1)}
                                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                                      >
                                        <ArrowUp className="h-3.5 w-3.5" /> Move earlier
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => moveOrder(item.originalIndex, 1)}
                                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                                      >
                                        <ArrowDown className="h-3.5 w-3.5" /> Move later
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => moveToTomorrow(item.originalIndex)}
                                        className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                                      >
                                        Move to Tomorrow
                                      </button>
                                    </>
                                  )}
                                  <div className="ml-auto flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingIdx(null);
                                        setEditForm(null);
                                      }}
                                      className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={saveEdit}
                                      className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                                    >
                                      Save
                                    </button>
                                  </div>
                                </div>
                                {!item.isFixed && (
                                  <div className="border-t border-border/70 pt-2">
                                    <button
                                      type="button"
                                      onClick={() => requestDeleteTask(item.originalIndex)}
                                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" /> Delete task
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {item && (
                              <button
                                type="button"
                                onClick={() => (isEditing ? (setEditingIdx(null), setEditForm(null)) : startEdit(item.originalIndex))}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                aria-label={isEditing ? "Collapse editor" : `Edit ${entry.title}`}
                              >
                                {isEditing ? (<><ChevronUp className="h-3.5 w-3.5" /> Collapse</>) : (<><Pencil className="h-3.5 w-3.5" /> Edit</>)}
                              </button>
                            )}
                            {isFlexible && (
                              <span
                                className="hidden sm:inline-flex cursor-grab items-center px-1 text-muted-foreground/60"
                                aria-hidden
                              >
                                <GripVertical className="h-4 w-4" />
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                      </Fragment>
                    );
                  })}
                  {renderDropZone(scheduleWithMeta.length)}
                </ol>
              )}

              <div className="mt-5">
                {addMode === null && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={openAddTask}
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-background/70 px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/60"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} /> Add task
                    </button>
                    <button
                      type="button"
                      onClick={openAddBreak}
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-background/70 px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/60"
                    >
                      <Coffee className="h-3.5 w-3.5" strokeWidth={1.8} /> Add break
                    </button>
                  </div>
                )}

                {addMode === "task" && (
                  <div className="rounded-xl border border-border bg-background/70 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-foreground">New task</h3>
                      <button type="button" onClick={() => setAddMode(null)} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-accent">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground">Title</label>
                      <input
                        autoFocus
                        value={addTaskForm.title}
                        onChange={(e) => setAddTaskForm({ ...addTaskForm, title: e.target.value })}
                        placeholder="e.g. Reply to Alex"
                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                      />
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-muted-foreground">Duration (min)</label>
                        <input
                          type="number"
                          min={5}
                          step={5}
                          value={addTaskForm.durationMinutes}
                          onChange={(e) => setAddTaskForm({ ...addTaskForm, durationMinutes: parseInt(e.target.value, 10) || 5 })}
                          className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-muted-foreground">Priority</label>
                        <select
                          value={addTaskForm.priority}
                          onChange={(e) => setAddTaskForm({ ...addTaskForm, priority: e.target.value as Priority })}
                          className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                        >
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" onClick={() => setAddMode(null)} className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-accent">Cancel</button>
                      <button type="button" onClick={submitAddTask} className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90">Add task</button>
                    </div>
                  </div>
                )}

                {addMode === "break" && (
                  <div className="rounded-xl border border-border bg-background/70 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-foreground">New break</h3>
                      <button type="button" onClick={() => setAddMode(null)} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-accent">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground">Break name</label>
                      <input
                        value={addBreakForm.title}
                        onChange={(event) => setAddBreakForm({ ...addBreakForm, title: event.target.value })}
                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground">Duration (min)</label>
                      <input
                        type="number"
                        min={5}
                        step={5}
                        value={addBreakForm.durationMinutes}
                        onChange={(e) => setAddBreakForm({ ...addBreakForm, durationMinutes: parseInt(e.target.value, 10) || 5 })}
                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">DailyNest will place it in the next workable spot.</p>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" onClick={() => setAddMode(null)} className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-accent">Cancel</button>
                      <button type="button" onClick={submitAddBreak} className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90">Add break</button>
                    </div>
                  </div>
                )}
              </div>



              {tomorrow.length > 0 && (
                <div className="mt-10">
                  <div className="flex items-center gap-3 border-b border-border/60 pb-4">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary text-primary">
                      <Calendar className="h-5 w-5" strokeWidth={1.5} />
                    </div>
                    <h2 className="font-serif text-3xl font-normal leading-none text-foreground">Tomorrow</h2>
                  </div>
                  <ul className="mt-3 space-y-2.5">
                    {tomorrow.map((t) => {
                      const item = items.find((i) => i.originalIndex === t.itemIndex);
                      const isEditing = editingIdx === t.itemIndex;
                      return (
                        <li id={`tomorrow-item-${t.itemIndex}`} key={`tm-${t.itemIndex}`} className="rounded-xl border border-border bg-card p-3 sm:p-4">
                          <div className="flex items-start gap-3 sm:gap-4">
                            <div className="rounded-lg bg-secondary text-secondary-foreground w-11 h-11 flex items-center justify-center shrink-0">
                              <Calendar className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="text-xs font-medium text-muted-foreground">{item?.dueCategory === "today" ? "Couldn’t fit today" : "Tomorrow"}</span>
                                <PriorityPill p={t.priority} />
                                {t.dueLabel && item && <DueLabel label={t.dueLabel} cat={item.dueCategory} />}
                              </div>
                              <div className="mt-1 text-sm font-medium text-foreground">{t.title}</div>
                              <div className="mt-0.5 text-xs text-muted-foreground">{formatDuration(t.remainingMinutes)} remaining</div>
                              {isEditing && editForm && item && (
                                <div className="mt-3 rounded-lg border border-border bg-background/70 p-3 space-y-2">
                                  <div>
                                    <label className="block text-xs font-medium text-muted-foreground">Title</label>
                                    <input
                                      value={editForm.title}
                                      onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                                      className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                    />
                                  </div>
                                  <div className="flex flex-col sm:flex-row gap-2">
                                    <div className="flex-1">
                                      <label className="block text-xs font-medium text-muted-foreground">Due date</label>
                                      <input
                                        type="date"
                                        value={editForm.dueDate}
                                        onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })}
                                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                      />
                                    </div>
                                    <div className="flex-1">
                                      <label className="block text-xs font-medium text-muted-foreground">Duration (min)</label>
                                      <input
                                        type="number"
                                        min={5}
                                        step={5}
                                        value={editForm.durationMinutes}
                                        onChange={(e) => setEditForm({ ...editForm, durationMinutes: parseInt(e.target.value, 10) || 5 })}
                                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                      />
                                    </div>
                                  </div>
                                  <div className="flex justify-end gap-2 pt-1">
                                    <button
                                      type="button"
                                      onClick={() => { setEditingIdx(null); setEditForm(null); }}
                                      className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-accent"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={saveEdit}
                                      className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                                    >
                                      Save
                                    </button>
                                  </div>
                                  <div className="border-t border-border/70 pt-2">
                                    <button
                                      type="button"
                                      onClick={() => requestDeleteTask(item.originalIndex)}
                                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" /> Delete task
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1 sm:gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => requestMoveToToday(t.itemIndex)}
                                className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                              >
                                Move to today
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(t.itemIndex)}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              >
                                <Pencil className="h-3.5 w-3.5" /> Edit
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

            </div>
          )}
        </section>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Sprout className="h-4 w-4 text-primary/70" strokeWidth={1.6} />
          {items && !loading
            ? "You're building a great rhythm. Keep going."
            : "We'll build a plan that feels doable and kind to you."}
        </p>
      </div>

      {deleteTaskTarget && (
        <div
          className="fixed inset-0 z-[70] grid place-items-center bg-foreground/20 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteTaskTarget(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-lg"
          >
            <h2 id="delete-task-title" className="text-base font-semibold text-foreground">
              Delete this task?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              &lsquo;{deleteTaskTarget.title}&rsquo; will be removed from your plan.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTaskTarget(null)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteTask}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
              >
                Delete task
              </button>
            </div>
          </div>
        </div>
      )}

      {fullDayFlow && items && !showGuestCard && !confirmNewPlan && (() => {
        const newTask = items.find((item) => item.originalIndex === fullDayFlow.taskIndex);
        if (!newTask) return null;
        const manualTasks = items.filter(
          (item) =>
            item.originalIndex !== newTask.originalIndex &&
            item.itemType !== "break" &&
            item.suggestedDay === "today" &&
            !item.isFixed &&
            schedule.some((entry) => entry.itemIndex === item.originalIndex),
        );
        const selectedManualTask = manualTasks.find(
          (item) => item.originalIndex === fullDayFlow.manualTargetIndex,
        );
        const selectedManualMinutes = selectedManualTask
          ? schedule
              .filter((entry) => entry.itemIndex === selectedManualTask.originalIndex)
              .reduce((total, entry) => total + entry.endMinutes - entry.startMinutes, 0)
          : 0;
        const manualKeepIsValid =
          Number.isInteger(fullDayFlow.manualKeepMinutes) &&
          fullDayFlow.manualKeepMinutes > 0 &&
          fullDayFlow.manualKeepMinutes < selectedManualMinutes;
        const manualMinutesFreed = manualKeepIsValid
          ? selectedManualMinutes - fullDayFlow.manualKeepMinutes
          : 0;
        const exactMinutesNeeded = roomContext ? getRoomMinutesNeeded(roomContext) : newTask.durationMinutes;
        const manualAdjustment =
          selectedManualTask && manualKeepIsValid
            ? ({
                kind: "shorten",
                targetIndex: selectedManualTask.originalIndex,
                keepMinutes: fullDayFlow.manualKeepMinutes,
              } satisfies RoomAdjustment)
            : null;
        const manualPreview =
          roomContext && manualAdjustment
            ? previewRoomAdjustment(roomContext, manualAdjustment)
            : null;
        const manualMinutesStillNeeded = Math.max(
          0,
          exactMinutesNeeded - manualMinutesFreed,
          newTask.durationMinutes - (manualPreview?.newTaskScheduledMinutes ?? 0),
        );
        const manualCanApply =
          manualKeepIsValid &&
          Boolean(manualPreview?.enoughRoom) &&
          (manualPreview?.newTaskScheduledMinutes ?? 0) >= newTask.durationMinutes;

        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/15 px-0 sm:px-4 sm:pb-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeFullDayFlow();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="full-day-sheet-title"
              className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl border border-border bg-card px-6 pb-7 pt-6 shadow-xl sm:rounded-3xl sm:px-8 sm:pb-8"
            >
              <div className="-mx-6 flex-1 overflow-y-auto px-6 sm:-mx-8 sm:px-8">
              {fullDayFlow.stage === "notice" && (
                <>
                  <h3 id="full-day-sheet-title" className="font-serif text-2xl text-foreground">
                    Today is already full
                  </h3>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                    “{newTask.title}” was placed tomorrow because there isn’t enough realistic time left today.
                  </p>
                  <div className="mt-6 space-y-2">
                    <button
                      type="button"
                      onClick={closeFullDayFlow}
                      className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      Keep it tomorrow
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setFullDayFlow((current) =>
                          current ? { ...current, stage: "suggestions", message: null } : current,
                        )
                      }
                      className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-accent"
                    >
                      Make room today
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={undoFullDayPlacement}
                    className="mx-auto mt-5 block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Undo
                  </button>
                </>
              )}

              {fullDayFlow.stage === "suggestions" && (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 id="full-day-sheet-title" className="font-serif text-2xl text-foreground">
                        Make room for “{newTask.title}”
                      </h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Choose how to make room.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeFullDayFlow}
                      aria-label="Close"
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-8 space-y-3">
                    {exactMinutesNeeded > 0 &&
                      cutoffMinutes + exactMinutesNeeded <= 23 * 60 + 59 && (
                        <button
                          type="button"
                          onClick={() =>
                            selectRoomAdjustment(
                              { kind: "extend", minutes: exactMinutesNeeded },
                              "suggestions",
                            )
                          }
                          className="w-full rounded-2xl border border-border bg-background p-4 text-left transition-colors hover:bg-accent/60"
                        >
                          <span className="block text-sm font-medium text-foreground">
                            Extend today by {exactMinutesNeeded} min
                          </span>
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() =>
                        setFullDayFlow((current) =>
                          current ? { ...current, stage: "choose", message: null } : current,
                        )
                      }
                      className="w-full rounded-2xl border border-border bg-background p-4 text-left transition-colors hover:bg-accent/60"
                    >
                      <span className="block text-sm font-medium text-foreground">
                        Choose a task to adjust
                      </span>
                    </button>
                  </div>
                </>
              )}

              {fullDayFlow.stage === "choose" && (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 id="full-day-sheet-title" className="font-serif text-2xl text-foreground">
                        Make room
                      </h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Pick a task to move or shorten.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeFullDayFlow}
                      aria-label="Close"
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-4 max-h-40 space-y-2 overflow-y-auto pr-1">
                    {manualTasks.map((task) => (
                      <button
                        key={task.originalIndex}
                        type="button"
                        onClick={() => {
                          const plannedMinutes = schedule
                            .filter((entry) => entry.itemIndex === task.originalIndex)
                            .reduce(
                              (total, entry) => total + entry.endMinutes - entry.startMinutes,
                              0,
                            );
                          setFullDayFlow((current) =>
                            current
                              ? {
                                  ...current,
                                  manualTargetIndex: task.originalIndex,
                                  manualKeepMinutes: plannedMinutes - exactMinutesNeeded,
                                  message: null,
                                }
                              : current,
                          );
                        }}
                        className={`flex w-full items-center justify-between rounded-xl border p-3 text-left ${
                          selectedManualTask?.originalIndex === task.originalIndex
                            ? "border-primary bg-secondary/60"
                            : "border-border bg-background"
                        }`}
                      >
                        <span className="text-sm font-medium text-foreground">{task.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDuration(
                            schedule
                              .filter((entry) => entry.itemIndex === task.originalIndex)
                              .reduce(
                                (total, entry) => total + entry.endMinutes - entry.startMinutes,
                                0,
                              ),
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                  {selectedManualTask && (
                    <div className="mt-4 border-t border-border pt-4">
                      <div className="rounded-xl border border-border bg-background p-4">
                        <p className="text-sm font-medium text-foreground">
                          {selectedManualTask.title}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-foreground">
                          <input
                            type="number"
                            min={1}
                            max={Math.max(1, selectedManualMinutes - 1)}
                            step={1}
                            value={fullDayFlow.manualKeepMinutes}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value);
                              setFullDayFlow((current) =>
                                current
                                  ? {
                                      ...current,
                                      manualKeepMinutes: Number.isFinite(nextValue)
                                        ? nextValue
                                        : 0,
                                      message: null,
                                    }
                                  : current,
                              );
                            }}
                            className="w-14 rounded-md border border-border bg-card px-2 py-1 text-right text-sm"
                          />
                          <span>min today</span>
                        </div>
                        {manualKeepIsValid ? (
                          <>
                            <p className="mt-2 text-sm text-muted-foreground">
                              {formatDuration(manualMinutesFreed)} tomorrow
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {newTask.title}: {formatDuration(newTask.durationMinutes)} today
                            </p>
                          </>
                        ) : (
                          <p className="mt-2 text-xs text-destructive">
                            Enter a whole number from 1 to{" "}
                            {Math.max(1, selectedManualMinutes - 1)}.
                          </p>
                        )}
                        {manualKeepIsValid && manualMinutesStillNeeded > 0 && (
                          <p className="mt-2 text-xs text-destructive">
                            Create {formatDuration(manualMinutesStillNeeded)} more room to add{" "}
                            {newTask.title} today.
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={!manualCanApply}
                          onClick={() => applyRoomPreview(manualPreview)}
                          className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Update my plan
                        </button>
                        {manualKeepIsValid && (
                          <details className="mt-3 group">
                            <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                              Details <span className="inline-block transition-transform group-open:rotate-180">▾</span>
                            </summary>
                            <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                              <div className="flex justify-between gap-3">
                                <dt>Original block</dt>
                                <dd className="text-foreground">{formatDuration(selectedManualMinutes)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt>Keeping today ({selectedManualTask.title})</dt>
                                <dd className="text-foreground">{formatDuration(fullDayFlow.manualKeepMinutes)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt>Continuing tomorrow ({selectedManualTask.title})</dt>
                                <dd className="text-foreground">{formatDuration(manualMinutesFreed)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt>{newTask.title} today</dt>
                                <dd className="text-foreground">{formatDuration(newTask.durationMinutes)}</dd>
                              </div>
                              <p className="pt-1">Due date stays the same.</p>
                            </dl>
                          </details>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          selectRoomAdjustment(
                            { kind: "move", targetIndex: selectedManualTask.originalIndex },
                            "choose",
                          )
                        }
                        className="mt-4 inline-flex items-center justify-center rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        Move entire task to tomorrow
                      </button>
                    </div>
                  )}
                  {manualTasks.length === 0 && (
                    <p className="mt-5 text-sm text-muted-foreground">
                      There are no flexible task blocks to adjust.
                    </p>
                  )}
                  {fullDayFlow.message && (
                    <p className="mt-4 text-xs text-muted-foreground">{fullDayFlow.message}</p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setFullDayFlow((current) =>
                        current ? { ...current, stage: "suggestions", message: null } : current,
                      )
                    }
                    className="mt-5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Go back
                  </button>
                </>
              )}

              {fullDayFlow.stage === "preview" && roomPreview && (
                <>
                  <h3 id="full-day-sheet-title" className="font-serif text-2xl text-foreground">
                    Preview
                  </h3>
                  <div className="mt-4 rounded-2xl border border-border bg-background p-4">
                    <p className="text-sm font-medium text-foreground">
                      {roomPreview.enoughRoom
                        ? `Room made for “${newTask.title}”`
                        : `Need ${formatDuration(roomPreview.missingMinutes)} more room`}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {roomPreview.impacts.map((impact, index) => (
                        <li key={`${impact.kind}-${impact.taskIndex ?? "time"}-${index}`} className="text-sm text-foreground">
                          {impact.kind === "shorten" &&
                            `${impact.title}: ${formatDuration(impact.beforeMinutes)} → ${formatDuration(impact.afterMinutes)}`}
                          {impact.kind === "move" && `Move ${impact.title} to tomorrow`}
                          {impact.kind === "remove" && `Remove ${impact.title} from today`}
                          {impact.kind === "extend" && `Extend today by ${formatDuration(impact.minutesFreed)}`}
                          {impact.kind === "start" && `Add ${impact.title} today`}
                        </li>
                      ))}
                    </ul>
                    {roomPreview.enoughRoom && (
                      <div className="mt-4 border-t border-border pt-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          New time blocks
                        </p>
                        <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                          {roomPreview.result.schedule.map((entry) => (
                            <li key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                              <span className="truncate text-foreground">{entry.title}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {minutesToTimeLabel(entry.startMinutes)}–{minutesToTimeLabel(entry.endMinutes)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="mt-5 space-y-2">
                    {roomPreview.enoughRoom ? (
                      <button
                        type="button"
                        onClick={() => applyRoomPreview()}
                        className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Update my plan
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setFullDayFlow((current) =>
                            current
                              ? { ...current, stage: "choose", adjustment: null, message: null }
                              : current,
                          )
                        }
                        className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Adjust more
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setFullDayFlow((current) =>
                          current
                            ? { ...current, stage: current.previewFrom, adjustment: null, message: null }
                            : current,
                        )
                      }
                      className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground hover:bg-accent"
                    >
                      Back
                    </button>
                  </div>
                </>
              )}
              </div>
            </div>
          </div>
        );
      })()}

      {breakRoomFlow && items && !crowded && !fullDayFlow && !showGuestCard && !confirmNewPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 px-4">
          <div role="dialog" aria-modal="true" aria-labelledby="break-room-title" className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="break-room-title" className="font-serif text-2xl text-foreground">
                  Make room for a {breakRoomFlow.item.durationMinutes}-minute break
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your plan needs {formatDuration(breakRoomFlow.neededMinutes)} more. Choose one adjustment and DailyNest will place the break automatically.
                </p>
              </div>
              <button type="button" onClick={skipPendingBreak} aria-label="Close and skip this break" className="rounded-md p-1 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>

            {breakRoomFlow.stage === "options" ? (
              <div className="mt-5 space-y-2">
                <button
                  type="button"
                  disabled={cutoffMinutes + breakRoomFlow.neededMinutes > 23 * 60 + 59}
                  onClick={extendForBreak}
                  className="w-full rounded-xl border border-border bg-background p-3 text-left hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block text-sm font-medium text-foreground">Extend available time</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Move today&apos;s stop time {formatDuration(breakRoomFlow.neededMinutes)} later.
                  </span>
                </button>
                <button
                  type="button"
                  disabled={movableTasksForBreak.length === 0}
                  onClick={() => setBreakRoomFlow((current) => current ? { ...current, stage: "move-task" } : current)}
                  className="w-full rounded-xl border border-border bg-background p-3 text-left hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block text-sm font-medium text-foreground">Move a task</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Move enough flexible work to tomorrow to create room. Fixed commitments cannot be moved.
                  </span>
                </button>
                <button
                  type="button"
                  disabled={movableTasksForBreak.length === 0}
                  onClick={() => setBreakRoomFlow((current) => current ? { ...current, stage: "shorten-task" } : current)}
                  className="w-full rounded-xl border border-border bg-background p-3 text-left hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block text-sm font-medium text-foreground">Shorten a task</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Reduce today&apos;s scheduled portion and preserve the remaining work for tomorrow.
                  </span>
                </button>
                {breakRoomFlow.shorterDurations.length > 0 && (
                  <div className="rounded-xl border border-border bg-background p-3">
                    <span className="block text-sm font-medium text-foreground">Use a shorter break</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Choose a duration that fits without moving any work.</span>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {breakRoomFlow.shorterDurations.map((duration) => (
                        <button key={duration} type="button" onClick={() => selectShorterBreak(duration)} className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-accent">
                          {duration} minutes
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button type="button" onClick={skipPendingBreak} className="w-full rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
                  Skip this break
                </button>
              </div>
            ) : (
              <div className="mt-5">
                <p className="text-sm text-muted-foreground">
                  Select one movable task. {formatDuration(breakRoomFlow.neededMinutes)} will be preserved for tomorrow.
                </p>
                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                  {movableTasksForBreak.map(({ item, scheduledMinutes }) => (
                    <button key={item.originalIndex} type="button" onClick={() => applyBreakTaskChoice(item.originalIndex)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-background p-3 text-left hover:bg-accent/60">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {breakRoomFlow.stage === "move-task" ? "Move" : "Shorten by"} {formatDuration(breakRoomFlow.neededMinutes)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(scheduledMinutes)} today</span>
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setBreakRoomFlow((current) => current ? { ...current, stage: "options" } : current)} className="mt-4 w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground hover:bg-accent">
                  Back
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showConflictModal && !breakRoomFlow && breakConflicts.length > 0 && items && !crowded && !fullDayFlow && !showGuestCard && !confirmNewPlan && (() => {
        const conflict = breakConflicts[0];
        const breakItem = items.find((item) => item.originalIndex === conflict.breakItemIndex);
        const otherItem = items.find((item) => item.originalIndex === conflict.otherItemIndex);
        const canShorten = !!breakItem?.fixedStart && conflict.overlapStartMinutes - hhmmToMinutes(breakItem.fixedStart) >= 5;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 px-4">
            <div role="dialog" aria-modal="true" aria-labelledby="break-conflict-title" className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 id="break-conflict-title" className="font-serif text-2xl text-foreground">This break overlaps another block</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{breakItem?.title ?? "Break"}</span> overlaps {otherItem?.title ?? "another block"} from {minutesToTimeLabel(conflict.overlapStartMinutes)}–{minutesToTimeLabel(conflict.overlapEndMinutes)}.
                  </p>
                </div>
                <button type="button" onClick={() => setShowConflictModal(false)} aria-label="Close break conflict" className="rounded-md p-1 text-muted-foreground hover:bg-accent">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => resolveBreakConflict("move")} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Move break</button>
                <button type="button" disabled={!canShorten} onClick={() => resolveBreakConflict("shorten")} className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">Shorten break</button>
                <button type="button" onClick={() => resolveBreakConflict("remove")} className="rounded-md px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10">Remove break</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showConflictModal && !breakRoomFlow && breakConflicts.length === 0 && conflicts.length > 0 && items && !crowded && !fullDayFlow && !showGuestCard && !confirmNewPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 px-4">
          <div role="dialog" aria-modal="true" aria-labelledby="conflict-modal-title" className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <h3 id="conflict-modal-title" className="font-serif text-2xl text-foreground">
                {overlapConflicts.length > 0 ? "Two commitments overlap" : "A few things need your attention"}
              </h3>
              <button
                type="button"
                onClick={() => setShowConflictModal(false)}
                aria-label="Close conflict summary"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {overlapConflicts.length > 0 ? (
              <div className="mt-4 space-y-4">
                {(() => {
                  const overlap = overlapConflicts[0];
                  const first = items.find((item) => item.originalIndex === overlap.firstItemIndex);
                  const second = items.find((item) => item.originalIndex === overlap.secondItemIndex);
                  return (
                    <>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">{first?.title ?? "One commitment"}</span> and{" "}
                        <span className="font-medium text-foreground">{second?.title ?? "another commitment"}</span> overlap from {minutesToTimeLabel(overlap.overlapStartMinutes)}–{minutesToTimeLabel(overlap.overlapEndMinutes)}.
                      </p>
                      {totalUnfit > 0 && (
                        <div className="rounded-xl border border-border bg-background/60 p-3">
                          <p className="text-sm text-muted-foreground">
                            Also, {formatDuration(totalUnfit)} of tasks could not fit before {cutoffLabel}.
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            They&apos;ve been moved to Tomorrow — scroll down to edit them.
                          </p>
                          {affectedRows.length > 0 && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setShowAffectedTasks((v) => !v)}
                                className="flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                              >
                                {showAffectedTasks ? "Hide affected tasks" : "Show affected tasks"}
                                {showAffectedTasks ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              </button>
                              {showAffectedTasks && (
                                <ul className="mt-2 space-y-1.5">
                                  {affectedRows.map((row, i) => (
                                    <li key={i} className="flex items-center justify-between gap-3 text-sm">
                                      <span className="truncate text-foreground">{row.title}</span>
                                      <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(row.minutes)}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {totalUnfit > 0 ? (
                  <div className="rounded-xl border border-border bg-background/60 p-3">
                    <p className="text-sm text-muted-foreground">
                      {formatDuration(totalUnfit)} of tasks could not fit before {cutoffLabel}.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      They&apos;ve been moved to Tomorrow — scroll down to edit them.
                    </p>
                    {affectedRows.length > 0 && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setShowAffectedTasks((v) => !v)}
                          className="flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {showAffectedTasks ? "Hide affected tasks" : "Show affected tasks"}
                          {showAffectedTasks ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                        {showAffectedTasks && (
                          <ul className="mt-2 space-y-1.5">
                            {affectedRows.map((row, i) => (
                              <li key={i} className="flex items-center justify-between gap-3 text-sm">
                                <span className="truncate text-foreground">{row.title}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(row.minutes)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    A few things need your attention. Review your plan to resolve them.
                  </p>
                )}
              </div>
            )}

            {overlapConflicts.length > 0 ? (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => editConflictItem(overlapConflicts[0].firstItemIndex)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Edit {items.find((item) => item.originalIndex === overlapConflicts[0].firstItemIndex)?.title ?? "first commitment"}
                </button>
                <button
                  type="button"
                  onClick={() => editConflictItem(overlapConflicts[0].secondItemIndex)}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                >
                  Edit {items.find((item) => item.originalIndex === overlapConflicts[0].secondItemIndex)?.title ?? "second commitment"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConflictModal(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Keep both for now
                </button>
              </div>
            ) : (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowConflictModal(false);
                    if (firstAffectedItemIndex !== null) scrollToItem(firstAffectedItemIndex);
                  }}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Review my plan
                </button>
                <button
                  type="button"
                  onClick={focusStopTime}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                >
                  Adjust end time
                </button>
              </div>
            )}
          </div>
        </div>
      )}




      {isGuest && showGuestCard && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-[0_20px_60px_-24px_rgba(30,60,45,0.35)]">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-primary">
                <Leaf className="h-5 w-5" strokeWidth={1.5} />
              </div>
              <h3 className="font-serif text-2xl text-foreground leading-tight">Keep your DailyNest going</h3>
            </div>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              Sign in to create more plans and save your schedule, weekly commitments, and preferences.
            </p>
            <div className="mt-6 space-y-2.5">
              <button
                type="button"
                onClick={onGuestGoogle}
                disabled={oauthLoading}
                className="w-full inline-flex items-center justify-center gap-3 rounded-full border border-border bg-background px-5 py-3 text-sm font-medium text-foreground hover:bg-secondary/60 transition disabled:opacity-60"
              >
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.5 29.3 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.3-3.5z"/>
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.5 29.3 4.5 24 4.5 16.1 4.5 9.3 8.9 6.3 14.7z"/>
                  <path fill="#4CAF50" d="M24 43.5c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.2-7.2 2.2-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.2 39 16 43.5 24 43.5z"/>
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.2-.1-2.3-.4-3.5z"/>
                </svg>
                {oauthLoading ? "Signing in…" : "Continue with Google"}
              </button>
              <button
                type="button"
                onClick={() => setShowGuestCard(false)}
                className="w-full rounded-full px-5 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition"
              >
                View this plan
              </button>
            </div>
          </div>
        </div>
      )}

      {undoIdx !== null && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-full border border-border bg-card/95 px-4 py-2 text-sm text-foreground shadow-md backdrop-blur-sm"
          >
            <Check className="h-4 w-4 text-primary" strokeWidth={2} />
            <span className="text-muted-foreground">Task completed</span>
            <button
              type="button"
              onClick={undoComplete}
              className="rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-secondary/60"
            >
              Undo
            </button>
          </div>
        </div>
      )}

      {confirmNewPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl">
            <h3 className="font-serif text-xl text-foreground">Start a new plan?</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">Your current plan will be cleared.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmNewPlan(false)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={startNewPlan}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Start New Plan
              </button>
            </div>
          </div>
        </div>
      )}
    </main>

  );
}
