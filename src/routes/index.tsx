import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Calendar, GripVertical, Pencil, ArrowUp, ArrowDown, X, AlertCircle } from "lucide-react";
import { planTasks } from "@/lib/planner.functions";
import type { PlanItem, Priority } from "@/lib/planner.types";
import { buildSchedule, computeOrder, formatDuration, minutesToTimeLabel } from "@/lib/scheduler";

export const Route = createFileRoute("/")({
  component: DailyNest,
});

const PLACEHOLDER = `pay rent due soon
call dentist
submit form Friday
buy snacks tomorrow`;

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
}

interface CrowdedProposal {
  itemIndex: number;
  needMin: number;
  availableMin: number;
}

function DailyNest() {
  const [raw, setRaw] = useState("");
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
  const historyRef = useRef<{ items: PlanItem[]; order: number[]; availableUntil: string } | null>(null);

  const plan = useServerFn(planTasks);

  const nowMinutes = useMemo(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }, [items]); // recompute when items change (rebuild triggers)

  const cutoffMinutes = hhmmToMinutes(availableUntil);

  const order = useMemo(() => (items ? computeOrder(items, userOrder) : []), [items, userOrder]);

  const { schedule, tomorrow, scheduledMinutes } = useMemo(() => {
    if (!items) return { schedule: [], tomorrow: [], scheduledMinutes: 0 };
    return buildSchedule({ items, order, nowMinutes, cutoffMinutes });
  }, [items, order, nowMinutes, cutoffMinutes]);

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
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setError("Add one task or worry per line, then make your plan.");
      return;
    }
    setLoading(true);
    try {
      const res = await plan({
        data: {
          tasks: lines,
          nowIso: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          availableUntil,
        },
      });
      setItems(res.items);
      setUserOrder([]);
      setUsedFallback(res.usedFallback);
    } catch (err) {
      console.error(err);
      setError("Something went wrong while making your plan. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [raw, availableUntil, plan]);

  const updateItems = (updater: (prev: PlanItem[]) => PlanItem[]) => {
    setItems((prev) => (prev ? updater(prev) : prev));
  };

  const startEdit = (idx: number) => {
    const it = items?.find((i) => i.originalIndex === idx);
    if (!it) return;
    setEditingIdx(idx);
    setEditForm({ title: it.title, dueDate: it.dueDate ?? "", durationMinutes: it.durationMinutes });
  };

  const saveEdit = () => {
    if (editingIdx === null || !editForm) return;
    pushHistory();
    updateItems((prev) =>
      prev.map((it) => {
        if (it.originalIndex !== editingIdx) return it;
        const { label, cat } = friendly(editForm.dueDate || null);
        return {
          ...it,
          title: editForm.title.trim() || it.title,
          dueDate: editForm.dueDate || null,
          dueLabel: label,
          dueCategory: cat,
          durationMinutes: Math.max(5, Math.round(editForm.durationMinutes / 5) * 5),
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
    updateItems((prev) => prev.map((it) => (it.originalIndex === idx ? { ...it, suggestedDay: "tomorrow" as const } : it)));
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
      items: items.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const } : x)),
      order: computeOrder(
        items.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const } : x)),
        [...userOrder, idx],
      ),
      nowMinutes,
      cutoffMinutes,
    });
    const overflow = test.tomorrow.find((t) => t.itemIndex === idx);
    const needMin = it.durationMinutes;
    const availableMin = Math.max(0, cutoffMinutes - Math.max(nowMinutes, 0));
    if (overflow && overflow.remainingMinutes > 0) {
      setCrowded({ itemIndex: idx, needMin, availableMin });
    } else {
      pushHistory();
      updateItems((prev) => prev.map((x) => (x.originalIndex === idx ? { ...x, suggestedDay: "today" as const } : x)));
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
        if (x.originalIndex === crowded.itemIndex) return { ...x, suggestedDay: "today" as const };
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
    updateItems((prev) => prev.map((x) => (x.originalIndex === crowded.itemIndex ? { ...x, suggestedDay: "today" as const } : x)));
    setUserOrder((o) => [...o, crowded.itemIndex]);
    setCrowded(null);
    flashStatus("Extended your available time and added the task.");
  };

  const crowdedDoPart = () => {
    if (!crowded) return;
    pushHistory();
    updateItems((prev) => prev.map((x) => (x.originalIndex === crowded.itemIndex ? { ...x, suggestedDay: "today" as const } : x)));
    setUserOrder((o) => [...o, crowded.itemIndex]);
    setCrowded(null);
    flashStatus("Placed as much as fits today; the rest is in Tomorrow.");
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

  return (
    <main className="min-h-screen w-full px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-[860px]">
        <header className="mb-8 sm:mb-10">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground">Planner</h1>
          <p className="mt-2 text-sm sm:text-base text-muted-foreground">
            A calm, honest plan for today — no dashboards, no streaks.
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_28px_-12px_rgba(30,60,45,0.12)] p-5 sm:p-8">
          <form onSubmit={onSubmit}>
            <label htmlFor="tasks" className="block text-sm font-medium text-foreground">
              Tasks and worries
            </label>
            <p className="mt-1 text-xs text-muted-foreground">One task, worry, commitment, or reminder per line.</p>
            <textarea
              id="tasks"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={PLACEHOLDER}
              rows={8}
              className="mt-3 w-full resize-y rounded-lg border border-input bg-background px-3.5 py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />

            <div className="mt-5 flex flex-col sm:flex-row sm:items-end gap-4">
              <div className="flex-1">
                <label htmlFor="until" className="block text-sm font-medium text-foreground">
                  Available until
                </label>
                <p className="mt-1 text-xs text-muted-foreground">We won't schedule tasks after this time.</p>
                <input
                  id="until"
                  type="time"
                  value={availableUntil}
                  onChange={(e) => setAvailableUntil(e.target.value)}
                  className="mt-2 w-full sm:w-40 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {loading ? "Making plan…" : "Make My Plan"}
              </button>
            </div>

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
            <div className="mt-10">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold text-foreground">Today</h2>
                <p className="text-sm text-muted-foreground">
                  {formatDuration(scheduledMinutes)} scheduled before {cutoffLabel}
                </p>
              </div>
              {usedFallback && (
                <p className="mt-1 text-xs text-muted-foreground">Using a local demo plan (no AI key needed).</p>
              )}

              {status && (
                <div className="mt-3 rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">{status}</div>
              )}

              {scheduleWithMeta.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">Nothing fits before your cutoff — see Tomorrow below.</p>
              ) : (
                <ol className="mt-4 space-y-2.5">
                  {scheduleWithMeta.map(({ entry, item }) => {
                    if (entry.kind === "break") {
                      return (
                        <li key={entry.id} className="rounded-lg border border-dashed border-border/80 bg-background/60 px-4 py-2.5">
                          <div className="flex items-center gap-4">
                            <div className="w-28 shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                              {minutesToTimeLabel(entry.startMinutes)}–{minutesToTimeLabel(entry.endMinutes)}
                            </div>
                            <div className="text-sm text-muted-foreground">Short break</div>
                          </div>
                        </li>
                      );
                    }
                    const isEditing = item && editingIdx === item.originalIndex;
                    const isFlexible = entry.kind === "task";
                    return (
                      <li
                        key={entry.id}
                        draggable={isFlexible && !isEditing}
                        onDragStart={isFlexible && item ? onDragStart(item.originalIndex) : undefined}
                        onDragOver={isFlexible ? onDragOver : undefined}
                        onDrop={isFlexible && item ? onDrop(item.originalIndex) : undefined}
                        className="group rounded-xl border border-border bg-card p-3 sm:p-4"
                      >
                        <div className="flex items-start gap-3 sm:gap-4">
                          <div className="flex flex-col items-center gap-1 shrink-0">
                            <div className="rounded-lg bg-secondary text-secondary-foreground w-11 h-11 flex items-center justify-center">
                              {entry.kind === "fixed" ? <Calendar className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                            </div>
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
                              {entry.dueLabel && entry.isFirstBlock && (
                                <DueLabel label={entry.dueLabel} cat={item?.dueCategory ?? "none"} />
                              )}
                            </div>
                            <div className="mt-1 text-sm font-medium text-foreground truncate">{entry.title}</div>
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
                            {item && !isEditing && (
                              <button
                                type="button"
                                onClick={() => startEdit(item.originalIndex)}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                aria-label={`Edit ${entry.title}`}
                              >
                                <Pencil className="h-3.5 w-3.5" /> Edit
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

              {tomorrow.length > 0 && (
                <div className="mt-10">
                  <h2 className="text-lg font-semibold text-foreground">Tomorrow</h2>
                  <ul className="mt-3 space-y-2.5">
                    {tomorrow.map((t) => {
                      const item = items.find((i) => i.originalIndex === t.itemIndex);
                      const isEditing = editingIdx === t.itemIndex;
                      return (
                        <li key={`tm-${t.itemIndex}`} className="rounded-xl border border-border bg-card p-3 sm:p-4">
                          <div className="flex items-start gap-3 sm:gap-4">
                            <div className="rounded-lg bg-secondary text-secondary-foreground w-11 h-11 flex items-center justify-center shrink-0">
                              <Calendar className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="text-xs font-medium text-muted-foreground">Tomorrow</span>
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

              <p className="mt-8 text-xs text-muted-foreground">Available until: {cutoffLabel}</p>
            </div>
          )}
        </section>
      </div>

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
                <div className="text-xs text-muted-foreground mt-0.5">Fit what you can; the rest stays in Tomorrow.</div>
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
    </main>
  );
}
