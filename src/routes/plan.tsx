import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Calendar, GripVertical, Pencil, ArrowUp, ArrowDown, X, AlertCircle, Leaf, Heart, Sprout, FileText, ChevronDown, ArrowRight, Coffee, ChevronUp, Mic, Square, Keyboard, Loader2 } from "lucide-react";
import { planTasks } from "@/lib/planner.functions";
import { transcribeAudio } from "@/lib/transcribe.functions";
import type { PlanItem, Priority } from "@/lib/planner.types";
import { buildSchedule, computeOrder, formatDuration, minutesToTimeLabel } from "@/lib/scheduler";
import { supabase } from "@/integrations/supabase/client";
import { ProfileMenu } from "@/components/ProfileMenu";

export const Route = createFileRoute("/plan")({
  component: PlanRoute,
});

function PlanRoute() {
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/auth", replace: true });
      } else {
        setAuthed(true);
      }
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) {
        setAuthed(false);
        navigate({ to: "/auth", replace: true });
      } else {
        setAuthed(true);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  if (!checked || !authed) {
    return (
      <main className="min-h-screen w-full grid place-items-center">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </main>
    );
  }

  return <DailyNest />;
}

const PLACEHOLDER = `Just dump everything on your mind — a to-do list, a rant, half-formed thoughts. Example:

Ugh today is so much. Rent is due soon and I still haven't paid it. I need to call the dentist at some point, and there's that form due Friday. Also want to grab snacks tomorrow. I'm just tired.`;

type InputMode = "type" | "voice";


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
  const [mode, setMode] = useState<InputMode>("type");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const [savedCommitments, setSavedCommitments] = useState<Array<{ id: string; name: string; days_of_week: number[]; start_time: string; end_time: string; enabled: boolean }>>([]);
  const historyRef = useRef<{ items: PlanItem[]; order: number[]; availableUntil: string } | null>(null);

  const plan = useServerFn(planTasks);
  const transcribe = useServerFn(transcribeAudio);

  // Load user defaults and commitments once
  useEffect(() => {
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) return;
      const [{ data: p }, { data: c }] = await Promise.all([
        supabase.from("profiles").select("default_available_until").eq("id", uid).maybeSingle(),
        supabase.from("fixed_commitments").select("*").eq("user_id", uid).eq("enabled", true),
      ]);
      if (p?.default_available_until) setAvailableUntil(p.default_available_until as string);
      setSavedCommitments((c ?? []) as unknown as typeof savedCommitments);
    })();
  }, []);


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
    const brainDump = raw.trim();
    if (!brainDump) {
      setError("Type or record what's on your mind, then make your plan.");
      return;
    }
    setLoading(true);
    try {
      const res = await plan({
        data: {
          brainDump,
          nowIso: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          availableUntil,
        },
      });
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
      setItems([...res.items, ...commitmentItems]);
      setUserOrder([]);
      setUsedFallback(res.usedFallback);
    } catch (err) {
      console.error(err);
      setError("Something went wrong while making your plan. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [raw, availableUntil, plan, savedCommitments]);

  const pickMimeType = (): string => {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  };

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMimeType();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
        const type = recorder.mimeType || mime || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type });
        audioChunksRef.current = [];
        if (blob.size < 1200) {
          setError("That recording was too short — try again and speak for a few seconds.");
          return;
        }
        setTranscribing(true);
        try {
          const buf = await blob.arrayBuffer();
          // base64 encode
          let binary = "";
          const bytes = new Uint8Array(buf);
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
          }
          const audioBase64 = btoa(binary);
          const res = await transcribe({ data: { audioBase64, mimeType: type } });
          const text = res.text.trim();
          if (!text) {
            setError("I couldn't hear anything in that recording. Try again?");
          } else {
            setRaw((prev) => (prev.trim() ? prev.trim() + "\n" + text : text));
            flashStatus("Added your voice note.");
          }
        } catch (err) {
          console.error(err);
          setError(err instanceof Error ? err.message : "Transcription failed. Please try again.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (err) {
      console.error(err);
      setError("Microphone access was blocked. Enable it in your browser to use voice input.");
    }
  }, [transcribe]);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    };
  }, []);


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
            <ProfileMenu />
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
                  What's on your mind?
                </label>
                <p className="mt-1 text-xs text-muted-foreground">Rant, list, half-thoughts — the AI will pull out what actually needs doing.</p>
              </div>
              <div role="tablist" aria-label="Input mode" className="inline-flex shrink-0 rounded-lg border border-border bg-background/60 p-1 text-xs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "type"}
                  onClick={() => { if (recording) stopRecording(); setMode("type"); }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition ${mode === "type" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Keyboard className="h-3.5 w-3.5" strokeWidth={1.8} /> Type
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "voice"}
                  onClick={() => setMode("voice")}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition ${mode === "voice" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Mic className="h-3.5 w-3.5" strokeWidth={1.8} /> Voice
                </button>
              </div>
            </div>

            <textarea
              id="tasks"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={PLACEHOLDER}
              rows={mode === "voice" ? 5 : 8}
              className="mt-4 w-full resize-y rounded-xl border border-input bg-background/70 px-4 py-3.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />

            {mode === "voice" && (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-secondary/30 p-5">
                <button
                  type="button"
                  onClick={recording ? stopRecording : startRecording}
                  disabled={transcribing}
                  aria-label={recording ? "Stop recording" : "Start recording"}
                  className={`grid h-16 w-16 place-items-center rounded-full shadow-sm transition focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-60 ${
                    recording
                      ? "bg-priority-high text-priority-high-fg animate-pulse"
                      : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                >
                  {transcribing ? <Loader2 className="h-7 w-7 animate-spin" /> : recording ? <Square className="h-6 w-6" fill="currentColor" /> : <Mic className="h-7 w-7" strokeWidth={1.8} />}
                </button>
                <p className="text-xs text-muted-foreground">
                  {transcribing
                    ? "Transcribing your voice note…"
                    : recording
                      ? `Listening… ${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, "0")} · Tap to stop`
                      : "Tap the mic and just talk. We'll add it to your notes above."}
                </p>
              </div>
            )}


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

            <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="relative w-full sm:w-56">
                <Clock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.6} />
                <input
                  id="until"
                  type="time"
                  value={availableUntil}
                  onChange={(e) => setAvailableUntil(e.target.value)}
                  className="w-full rounded-xl border border-input bg-background/70 pl-9 pr-9 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.6} />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-base font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {loading ? "Making plan…" : "Make My Plan"}
                {!loading && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.8} />}
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

              {status && (
                <div className="mt-3 rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">{status}</div>
              )}

              {scheduleWithMeta.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">Nothing fits before your cutoff — see Tomorrow below.</p>
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
