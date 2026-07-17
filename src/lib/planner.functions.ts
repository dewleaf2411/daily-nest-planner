import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { applyPlanningRules, getPlanningWindow } from "./planner.logic";
import type { PlanItem } from "./planner.types";

const InputSchema = z.object({
  brainDump: z.string().min(1),
  nowLocalIso: z.string(),
  timezone: z.string(),
  availableUntil: z.string(), // "HH:MM"
});

const SYSTEM = `You are Planner, a calm and realistic AI day planner. The user will paste a stream of consciousness — a rant, a mix of thoughts, worries, reminders, and commitments. Your job is to READ BETWEEN THE LINES and pull out ONLY the concrete, actionable items worth doing today or tomorrow.

Rules for what to extract:
- Ignore pure venting or emotional context that has no action ("I'm so tired", "ugh Mondays").
- Convert vague worries into ONE tiny concrete action ("I'm anxious about rent" -> "Pay rent").
- Deduplicate — if the user mentions the same thing twice, return one item.
- Detect fixed commitments (class at 10, meeting 3pm, appointment).
- Detect deadlines from words like "Friday", "tomorrow", "today", "due", "by", specific dates.
- Respect an explicit duration the user gives.
- Prioritize by consequence: overdue/due-today/essential = high; nice-to-have = low.
- Mark requiredToday true when the user clearly says a task must be completed today or tonight (for example, "must do today", "before bed", or "cannot wait until tomorrow"). This is separate from priority and from the task's actual dueDate.
- Long deep-work (study, write, project) => set focusBlockMinutes to 25/30/45.

Return a JSON array. Each item has:
- originalIndex (0-based, in the order you return them)
- title (short, action-oriented, imperative)
- durationMinutes (realistic integer)
- priority ("high" | "medium" | "low")
- requiredToday (boolean)
- reason (one short sentence — why this made the cut)
- dueDate (ISO "YYYY-MM-DD" or null)
- dueLabel ("Overdue" | "Due today" | "Due tomorrow" | "Due in N days" | null)
- dueCategory ("overdue" | "today" | "tomorrow" | "future" | "none")
- suggestedDay ("today" | "tomorrow")
- isFixed (true if an explicit clock time is stated)
- fixedStart ("HH:MM" 24h or null)
- fixedEnd ("HH:MM" or null)
- focusBlockMinutes (25 | 30 | 45 | null)
- note (short hint or null)

Return ONLY a JSON array. No prose, no markdown fences.`;

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function friendlyLabel(dueDate: string | null | undefined, todayIso: string): { label: string | null; cat: PlanItem["dueCategory"] } {
  if (!dueDate) return { label: null, cat: "none" };
  const diff = daysBetween(todayIso, dueDate);
  if (diff < 0) return { label: "Overdue", cat: "overdue" };
  if (diff === 0) return { label: "Due today", cat: "today" };
  if (diff === 1) return { label: "Due tomorrow", cat: "tomorrow" };
  return { label: `Due in ${diff} days`, cat: "future" };
}

// Very rough heuristic splitter used when no AI key is available.
function splitBrainDump(text: string): string[] {
  const chunks = text
    .split(/[\n\.;]+|,\s+and\s+|,\s+then\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  // Drop obvious venting-only lines
  const venty = /^(i(?:'m| am)?\s+(so\s+)?(tired|stressed|anxious|overwhelmed|exhausted|sad|angry|ugh)|ugh|argh|fml|why|help|idk)\b/i;
  return chunks.filter((c) => c.split(/\s+/).length >= 2 && !venty.test(c));
}

export function deterministicFallback(brainDump: string, nowLocalIso: string): PlanItem[] {
  const todayIso = nowLocalIso.slice(0, 10);
  const tasks = splitBrainDump(brainDump);
  return tasks.map((raw, i) => {
    const line = raw.trim();
    const lower = line.toLowerCase();
    const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    const hasTimeWord = /\bat\s+\d/.test(lower) || /\b(class|meeting|appointment|call at|shift|rehearsal)\b/.test(lower);
    let isFixed = false;
    let fixedStart: string | null = null;
    let fixedEnd: string | null = null;
    if (timeMatch && (hasTimeWord || timeMatch[3])) {
      let h = parseInt(timeMatch[1], 10);
      const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const mer = timeMatch[3];
      if (mer === "pm" && h < 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      if (h >= 0 && h <= 23) {
        isFixed = true;
        fixedStart = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const endH = Math.min(h + 1, 23);
        fixedEnd = `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }
    }

    let dueDate: string | null = null;
    if (/\bdue\s+next\s+week\b/.test(lower)) {
      const d = new Date(todayIso + "T00:00:00");
      d.setDate(d.getDate() + 7);
      dueDate = d.toISOString().slice(0, 10);
    } else if (/\btoday\b/.test(lower)) dueDate = todayIso;
    else if (/\btomorrow\b/.test(lower)) {
      const d = new Date(todayIso + "T00:00:00");
      d.setDate(d.getDate() + 1);
      dueDate = d.toISOString().slice(0, 10);
    } else if (/\b(friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/.test(lower)) {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const target = days.indexOf(lower.match(/\b(friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/)![1]);
      const d = new Date(todayIso + "T00:00:00");
      const cur = d.getDay();
      let diff = (target - cur + 7) % 7;
      if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
      dueDate = d.toISOString().slice(0, 10);
    } else if (/\b(due soon|asap|urgent)\b/.test(lower)) {
      dueDate = todayIso;
    }

    let priority: PlanItem["priority"] = "medium";
    if (/\b(rent|bill|urgent|asap|due soon|overdue)\b/.test(lower) || (dueDate && daysBetween(todayIso, dueDate) <= 0)) priority = "high";
    else if (/\b(snack|buy|maybe|someday|later)\b/.test(lower)) priority = "low";

    const explicitDuration = lower.match(/\b(\d{1,3})[-\s]*(minutes?|mins?|hours?|hrs?)\b/);
    let duration = 20;
    if (explicitDuration) {
      duration = parseInt(explicitDuration[1], 10) * (/^h/.test(explicitDuration[2]) ? 60 : 1);
    } else if (/\b(study|write|essay|project|read|design|code|prepare|research)\b/.test(lower)) duration = 90;
    else if (/\b(call|email|text|message)\b/.test(lower)) duration = 15;
    else if (/\b(pay|submit|form|book|schedule)\b/.test(lower)) duration = 15;
    else if (/\b(buy|shop|groceries|snacks|errand)\b/.test(lower)) duration = 30;
    else if (isFixed) duration = 60;

    const focusBlockMinutes = duration >= 60 && !isFixed ? 30 : null;
    const { label, cat } = friendlyLabel(dueDate, todayIso);

    const title = line.replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?/i, "").replace(/\s+/g, " ").trim();

    return {
      originalIndex: i,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      durationMinutes: duration,
      priority,
      requiredToday: false,
      reason: isFixed ? "Fixed commitment at a specific time." : priority === "high" ? "Time-sensitive or high-consequence." : "Keeps your day on track.",
      dueDate,
      dueLabel: label,
      dueCategory: cat,
      suggestedDay: "today",
      isFixed,
      fixedStart,
      fixedEnd,
      focusBlockMinutes,
      note: null,
    };
  });
}

export const planTasks = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<{ items: PlanItem[]; usedFallback: boolean }> => {
    const key = process.env.LOVABLE_API_KEY;
    const planningWindow = getPlanningWindow(data.nowLocalIso, data.availableUntil);
    const todayIso = planningWindow.todayIso;

    if (!key) {
      return { items: applyPlanningRules(deterministicFallback(data.brainDump, data.nowLocalIso), data.brainDump), usedFallback: true };
    }

    try {
      const gateway = createLovableAiGatewayProvider(key);
      const userPrompt = `Current local datetime: ${data.nowLocalIso}
Timezone: ${data.timezone}
Available until (today): ${data.availableUntil}
Exact planning window: ${planningWindow.nowMinutes} to ${planningWindow.cutoffMinutes} minutes after midnight (${planningWindow.availableMinutes} minutes remaining). Do not suggest more today work than can fit in this window after fixed commitments.

User brain dump (may include venting, ignore it — extract only real actions):
"""
${data.brainDump}
"""

Return the JSON array now.`;

      const { text } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        system: SYSTEM,
        prompt: userPrompt,
      });

      const cleaned = stripFences(text);
      const parsed = JSON.parse(cleaned) as PlanItem[];
      const normalized = parsed.map((p, i) => {
        const { label, cat } = friendlyLabel(p.dueDate ?? null, todayIso);
        return { ...p, originalIndex: i, requiredToday: p.requiredToday === true, dueLabel: label ?? p.dueLabel ?? null, dueCategory: cat };
      });
      return { items: applyPlanningRules(normalized, data.brainDump), usedFallback: false };
    } catch (err) {
      console.error("AI planning failed, using fallback:", err);
      return { items: applyPlanningRules(deterministicFallback(data.brainDump, data.nowLocalIso), data.brainDump), usedFallback: true };
    }
  });
