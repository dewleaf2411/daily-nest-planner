import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Calendar, GripVertical, Pencil, ArrowUp, ArrowDown, X, AlertCircle, Leaf, Heart, Sprout, FileText, ChevronDown, ArrowRight, Coffee, ChevronUp, Loader2, Check } from "lucide-react";
import { planTasks } from "@/lib/planner.functions";
import type { PlanItem, Priority, SchedulingConflict } from "@/lib/planner.types";
import { buildSchedule, computeOrder, formatDuration, minutesToTimeLabel } from "@/lib/scheduler";
import { supabase } from "@/integrations/supabase/client";
import { ProfileMenu } from "@/components/ProfileMenu";
import { WheelTimePicker } from "@/components/WheelTimePicker";
import { lovable } from "@/integrations/lovable/index";

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

interface CrowdedProposal {
  itemIndex: number;
  needMin: number;
  availableMin: number;
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
  const [crowded, setCrowded] = useState<CrowdedProposal | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [planNowMinutes, setPlanNowMinutes] = useState<number | null>(null);
  const [savedCommitments, setSavedCommitments] = useState<Array<{ id: string; name: string; days_of_week: number[]; start_time: string; end_time: string; enabled: boolean }>>([]);
  const [preferredName, setPreferredName] = useState<string>("");
  const [addMode, setAddMode] = useState<null | "task" | "break">(null);
  const [addTaskForm, setAddTaskForm] = useState<{ title: string; durationMinutes: number; priority: Priority }>({ title: "", durationMinutes: 15, priority: "medium" });
  const [addBreakForm, setAddBreakForm] = useState<{ durationMinutes: number; startTime: string }>({ durationMinutes: 15, startTime: "12:00" });
  const historyRef = useRef<{ items: PlanItem[]; order: number[]; availableUntil: string } | null>(null);
  const [completedTasks, setCompletedTasks] = useState<Set<number>>(new Set());
  const [undoIdx, setUndoIdx] = useState<number | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const [confirmNewPlan, setConfirmNewPlan] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showAffectedTasks, setShowAffectedTasks] = useState(false);
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
        };
        if (Array.isArray(parsed.items) && parsed.items.length > 0) setItems(parsed.items);
        if (Array.isArray(parsed.userOrder)) setUserOrder(parsed.userOrder);
        if (typeof parsed.availableUntil === "string") setAvailableUntil(parsed.availableUntil);
        if (Array.isArray(parsed.completedTasks)) setCompletedTasks(new Set(parsed.completedTasks));
        if (typeof parsed.raw === "string") setRaw(parsed.raw);
        if (typeof parsed.usedFallback === "boolean") setUsedFallback(parsed.usedFallback);
        if (typeof parsed.planNowMinutes === "number") setPlanNowMinutes(parsed.planNowMinutes);
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
        }),
      );
    } catch { /* ignore */ }
  }, [items, userOrder, availableUntil, completedTasks, raw, usedFallback, planNowMinutes]);

  const startNewPlan = useCallback(() => {
    setItems(null);
    setUserOrder([]);
    setCompletedTasks(new Set());
    setRaw("");
    setUsedFallback(false);
    setPlanNowMinutes(null);
    setEditingIdx(null);
    setEditForm(null);
    setUndoIdx(null);
    setStatus(null);
    setError(null);
    setShowConflictModal(false);
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
    return buildSchedule({ items, order, nowMinutes, cutoffMinutes });
  }, [items, order, nowMinutes, cutoffMinutes]);

  useEffect(() => {
    if (
      !items ||
      loading ||
      conflicts.length === 0 ||
      crowded ||
      showGuestCard ||
      confirmNewPlan ||
      presentedConflictKeyRef.current === "shown"
    ) {
      return;
    }
    presentedConflictKeyRef.current = "shown";
    setShowConflictModal(true);
  }, [conflicts.length, confirmNewPlan, crowded, items, loading, showGuestCard]);

  const pushHistory = () => {
    if (items) historyRef.current = { items: items.map((i) => ({ ...i })), order: [...order], availableUntil };
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
        return {
          ...it,
          title: editForm.title.trim() || it.title,
          dueDate: editForm.dueDate || null,
          dueLabel: label,
          dueCategory: cat,
          durationMinutes:
            fixedDuration ?? Math.max(5, Math.round(editForm.durationMinutes / 5) * 5),
          fixedStart,
          fixedEnd,
        };
      }),
    );
    setEditingIdx(null);
    setEditForm(null);
    flashStatus("Your changes were saved and the timeline was rebuilt.");
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
    updateItems((prev) => prev.map((it) => (it.originalIndex === idx ? { ...it, suggestedDay: "tomorrow" as const, deferredByUser: true } : it)));
    setUserOrder((o) => o.filter((i) => i !== idx));
    setEditingIdx(null);
    flashStatus("Moved to Tomorrow.");
  };

  const requestMoveToToday = (idx: number) => {
    if (!items) return;
    const it = items.find((i) => i.originalIndex === idx);
    if (!it) return;
    // check how much free time there is
    const test = buildSchedule({
      items: items.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const, deferredByUser: false } : x)),
      order: computeOrder(
        items.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const, deferredByUser: false } : x)),
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
    if (scheduledForTask < it.durationMinutes) {
      setCrowded({ itemIndex: idx, needMin, availableMin });
    } else {
      pushHistory();
      updateItems((prev) => prev.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const, deferredByUser: false } : x)));
      setUserOrder((o) => [...o, idx]);
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
    // Default break start = end of last scheduled entry (or now), rounded to 5.
    const lastEnd = schedule.length ? schedule[schedule.length - 1].endMinutes : nowMinutes;
    const start = Math.min(cutoffMinutes - 5, Math.ceil(Math.max(lastEnd, nowMinutes) / 5) * 5);
    const h = Math.floor(start / 60);
    const m = start % 60;
    setAddBreakForm({ durationMinutes: 15, startTime: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` });
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
    setItems((prev) => (prev ? [...prev, newItem] : [newItem]));
    setUserOrder((o) => [...o, idx]);
    setAddMode(null);
    flashStatus("Task added.");
  };

  const submitAddBreak = () => {
    const duration = Math.max(5, Math.round(addBreakForm.durationMinutes / 5) * 5);
    const [sh, sm] = addBreakForm.startTime.split(":").map((n) => parseInt(n, 10));
    const startMin = sh * 60 + (sm || 0);
    const endMin = Math.min(cutoffMinutes, startMin + duration);
    const eh = Math.floor(endMin / 60);
    const em = endMin % 60;
    pushHistory();
    const idx = nextIndex();
    const newItem: PlanItem = {
      originalIndex: idx,
      title: "Break",
      durationMinutes: endMin - startMin,
      priority: "low",
      requiredToday: false,
      reason: "Manual break",
      dueDate: null,
      dueLabel: null,
      dueCategory: "none",
      suggestedDay: "today",
      isFixed: true,
      fixedStart: addBreakForm.startTime,
      fixedEnd: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
      focusBlockMinutes: null,
      note: null,
    };
    setItems((prev) => (prev ? [...prev, newItem] : [newItem]));
    setAddMode(null);
    flashStatus("Break added.");
  };



  // Drag-and-drop for flexible today tasks
  const dragIdxRef = useRef<number | null>(null);
  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    dragIdxRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (targetIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragIdxRef.current;
    dragIdxRef.current = null;
    if (src === null || src === targetIdx) return;
    const cur = [...order];
    const from = cur.indexOf(src);
    const to = cur.indexOf(targetIdx);
    if (from < 0 || to < 0) return;
    cur.splice(to, 0, cur.splice(from, 1)[0]);
    pushHistory();
    setUserOrder(cur);
    flashStatus("Your order was kept and the timeline was rebuilt.");
  };

  // Group schedule entries by task to render blocks together
  const scheduleWithMeta = schedule.map((s) => {
    if (s.kind === "task") {
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
      if (conflict.type === "fixed_overlap") continue;
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
                  {overlapConflicts.length > 0 && (
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
                  {scheduleWithMeta.map(({ entry, item }) => {
                    if (entry.kind === "break") {
                      return (
                        <li key={entry.id} className="rounded-xl border border-border/60 bg-secondary/40 px-4 py-3">
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4">
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-background/70 text-primary">
                              <Coffee className="h-5 w-5" strokeWidth={1.5} />
                            </div>
                            <div className="flex min-w-0 items-center gap-3 text-sm">
                              <span className="font-medium text-muted-foreground tabular-nums">
                                {minutesToTimeLabel(entry.startMinutes)}–{minutesToTimeLabel(entry.endMinutes)}
                              </span>
                              <span className="text-muted-foreground">Short break</span>
                            </div>
                            <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2.5 py-0.5 text-xs text-priority-low-fg">
                              <Leaf className="h-3 w-3" strokeWidth={1.7} />
                              {formatDuration(entry.endMinutes - entry.startMinutes)}
                            </span>
                          </div>
                        </li>
                      );
                    }
                    const isEditing = item && editingIdx === item.originalIndex;
                    const isFlexible = entry.kind === "task";
                    return (
                      <li
                        id={item && (entry.kind === "fixed" || entry.isFirstBlock) ? `plan-item-${item.originalIndex}` : undefined}
                        key={entry.id}
                        draggable={isFlexible && !isEditing}
                        onDragStart={isFlexible && item ? onDragStart(item.originalIndex) : undefined}
                        onDragOver={isFlexible ? onDragOver : undefined}
                        onDrop={isFlexible && item ? onDrop(item.originalIndex) : undefined}
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
                            {entry.isFirstBlock && entry.totalDuration && (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                Total: {formatDuration(entry.totalDuration)} ·{" "}
                                {entry.focusBlockMinutes
                                  ? `Focus: ${entry.focusBlockMinutes} min`
                                  : "One work block"}
                              </div>
                            )}
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
                                      <input
                                        type="time"
                                        value={editForm.fixedStart}
                                        onChange={(e) => setEditForm({ ...editForm, fixedStart: e.target.value })}
                                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                                      />
                                    </div>
                                    <div className="flex-1">
                                      <label className="block text-xs font-medium text-muted-foreground">Ends at</label>
                                      <input
                                        type="time"
                                        value={editForm.fixedEnd}
                                        onChange={(e) => setEditForm({ ...editForm, fixedEnd: e.target.value })}
                                        className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
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
                    );
                  })}
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
                    <div className="flex flex-col sm:flex-row gap-2">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Start at</label>
                        <WheelTimePicker
                          value={addBreakForm.startTime}
                          onChange={(v) => setAddBreakForm({ ...addBreakForm, startTime: v })}
                          ariaLabel="Break start time"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-muted-foreground">Duration (min)</label>
                        <input
                          type="number"
                          min={5}
                          step={5}
                          value={addBreakForm.durationMinutes}
                          onChange={(e) => setAddBreakForm({ ...addBreakForm, durationMinutes: parseInt(e.target.value, 10) || 5 })}
                          className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
                        />
                      </div>
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

      {showConflictModal && conflicts.length > 0 && items && !crowded && !showGuestCard && !confirmNewPlan && (
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
                  const affectedMap = new Map<number, { title: string; minutes: number }>();
                  for (const conflict of conflicts) {
                    if (conflict.type === "fixed_overlap") continue;
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
              <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
                {conflicts.map((conflict, index) => {
                  if (conflict.type === "fixed_overlap") {
                    const first = items.find((item) => item.originalIndex === conflict.firstItemIndex);
                    const second = items.find((item) => item.originalIndex === conflict.secondItemIndex);
                    return (
                      <li key={`overlap-${conflict.firstItemIndex}-${conflict.secondItemIndex}`}>
                        <span className="font-medium text-foreground">{first?.title ?? "One commitment"}</span> and{" "}
                        <span className="font-medium text-foreground">{second?.title ?? "another commitment"}</span> both take place from {minutesToTimeLabel(conflict.overlapStartMinutes)}–{minutesToTimeLabel(conflict.overlapEndMinutes)}. DailyNest can&apos;t decide which one you will attend.
                      </li>
                    );
                  }
                  if (conflict.type === "fixed_displacement") {
                    const fixedDescriptions = conflict.fixedItemIndexes.map((itemIndex) => {
                      const item = items.find((candidate) => candidate.originalIndex === itemIndex);
                      return item
                        ? `${item.title} is fixed from ${minutesToTimeLabel(hhmmToMinutes(item.fixedStart ?? "00:00"))}–${minutesToTimeLabel(hhmmToMinutes(item.fixedEnd ?? "00:00"))}`
                        : null;
                    }).filter(Boolean);
                    const affectedNames = conflict.affectedItemIndexes.map(
                      (itemIndex) => items.find((item) => item.originalIndex === itemIndex)?.title,
                    ).filter(Boolean);
                    return (
                      <li key={`fixed-displacement-${index}`}>
                        {fixedDescriptions.join("; ")}, so {affectedNames.join(" and ") || "important work"} could not all fit before {cutoffLabel}.
                      </li>
                    );
                  }
                  if (conflict.type === "due_today_unfit") {
                    const item = items.find((candidate) => candidate.originalIndex === conflict.itemIndex);
                    return (
                      <li key={`due-${conflict.itemIndex}`}>
                        <span className="font-medium text-foreground">{item?.title ?? "A task"}</span> is due today{conflict.dueDate ? ` (${conflict.dueDate})` : ""} and still needs {formatDuration(conflict.remainingMinutes)}. Its due date has not changed, and it has not been marked complete.
                      </li>
                    );
                  }
                  if (conflict.type === "required_capacity") {
                    return (
                      <li key="required-capacity">
                        {formatDuration(conflict.requiredMinutes)} is due or required today, but only {formatDuration(conflict.scheduledMinutes)} fits before {cutoffLabel}. {formatDuration(conflict.missingMinutes)} still needs time.
                      </li>
                    );
                  }
                  const item = items.find((candidate) => candidate.originalIndex === conflict.itemIndex);
                  return (
                    <li key={`overflow-${conflict.itemIndex}`}>
                      <span className="font-medium text-foreground">{item?.title ?? "A task"}</span> could not fully fit today and still needs {formatDuration(conflict.remainingMinutes)}.
                    </li>
                  );
                })}
              </ul>
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

      {crowded && items && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-base font-semibold text-foreground">This may make today feel crowded</h3>
              <button
                type="button"
                onClick={() => setCrowded(null)}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              This task needs about {formatDuration(crowded.needMin)}, but only about {formatDuration(crowded.availableMin)} is free before {cutoffLabel}.
            </p>

            <div className="mt-4 space-y-2">
              <details className="rounded-lg border border-border bg-background/60 p-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground">Make room</summary>
                <ul className="mt-2 space-y-1.5">
                  {items
                    .filter((i) => !i.isFixed && i.suggestedDay === "today" && i.priority !== "high" && i.originalIndex !== crowded.itemIndex)
                    .map((i) => (
                      <li key={`mr-${i.originalIndex}`} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">
                          {i.title} <span className="text-muted-foreground">· {formatDuration(i.durationMinutes)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => crowdedMakeRoom(i.originalIndex)}
                          className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
                        >
                          Move to tomorrow
                        </button>
                      </li>
                    ))}
                  {items.filter((i) => !i.isFixed && i.suggestedDay === "today" && i.priority !== "high" && i.originalIndex !== crowded.itemIndex).length === 0 && (
                    <li className="text-xs text-muted-foreground">No lower-priority today tasks to move.</li>
                  )}
                </ul>
              </details>

              <button
                type="button"
                onClick={crowdedExtend}
                className="w-full text-left rounded-lg border border-border bg-background/60 p-3 text-sm font-medium text-foreground hover:bg-accent"
              >
                Extend to the suggested time
                <div className="text-xs text-muted-foreground mt-0.5">Adds up to 3 more hours today.</div>
              </button>

              <button
                type="button"
                onClick={crowdedDoPart}
                className="w-full text-left rounded-lg border border-border bg-background/60 p-3 text-sm font-medium text-foreground hover:bg-accent"
              >
                Do part today
                <div className="text-xs text-muted-foreground mt-0.5">Fit what you can; the remaining time stays in the conflict summary.</div>
              </button>

              {historyRef.current && (
                <button
                  type="button"
                  onClick={undo}
                  className="w-full text-left rounded-lg border border-border bg-background/60 p-3 text-sm font-medium text-foreground hover:bg-accent"
                >
                  Undo move
                </button>
              )}
            </div>
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
