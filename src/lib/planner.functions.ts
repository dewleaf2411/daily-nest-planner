import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import type { PlanItem } from "./planner.types";

const InputSchema = z.object({
  tasks: z.array(z.string()).min(1),
  nowIso: z.string(),
  timezone: z.string(),
  availableUntil: z.string(), // "HH:MM"
});

const SYSTEM = `You are DailyNest, a calm and realistic AI day planner. You turn each raw user line (task, worry, commitment, reminder) into ONE structured planning item.

For every input line return JSON with these keys:
- originalIndex (number, 0-based, must match input order)
- title (short, action-oriented)
- durationMinutes (integer, realistic estimate)
- priority ("high" | "medium" | "low")
- reason (one sentence)
- dueDate (ISO date "YYYY-MM-DD" or null)
- dueLabel ("Overdue" | "Due today" | "Due tomorrow" | "Due in N days" | null)
- dueCategory ("overdue" | "today" | "tomorrow" | "future" | "none")
- suggestedDay ("today" | "tomorrow")
- isFixed (true if user gave an exact time like "3pm meeting", "class at 10:00")
- fixedStart ("HH:MM" 24h or null)
- fixedEnd ("HH:MM" or null)
- focusBlockMinutes (25, 30, or 45 for long deep-work tasks; else null)
- note (short overflow/fit hint, or null)

Rules:
- Detect deadlines from words like "Friday", "tomorrow", "today", "due", "by", specific dates.
- Fixed commitments: classes, appointments, work shifts, rehearsals, or anything with an explicit clock time.
- High priority: overdue, due today, essential, high-consequence.
- Long deep-work (study, write, project) => set focusBlockMinutes to 25/30/45.
- Short tasks (< 45 min) => focusBlockMinutes null.
- Worries without action => convert to a small actionable step.

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

function deterministicFallback(tasks: string[], nowIso: string): PlanItem[] {
  const todayIso = nowIso.slice(0, 10);
  return tasks.map((raw, i) => {
    const line = raw.trim();
    const lower = line.toLowerCase();
    // fixed-time detection
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

    // due detection
    let dueDate: string | null = null;
    if (/\btoday\b/.test(lower)) dueDate = todayIso;
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

    // priority
    let priority: PlanItem["priority"] = "medium";
    if (/\b(rent|bill|urgent|asap|due soon|overdue)\b/.test(lower) || (dueDate && daysBetween(todayIso, dueDate) <= 0)) priority = "high";
    else if (/\b(snack|buy|maybe|someday|later)\b/.test(lower)) priority = "low";

    // duration
    let duration = 20;
    if (/\b(study|write|essay|project|read|design|code|prepare|research)\b/.test(lower)) duration = 90;
    else if (/\b(call|email|text|message)\b/.test(lower)) duration = 15;
    else if (/\b(pay|submit|form|book|schedule)\b/.test(lower)) duration = 15;
    else if (/\b(buy|shop|groceries|snacks|errand)\b/.test(lower)) duration = 30;
    else if (isFixed) duration = 60;

    const focusBlockMinutes = duration >= 60 && !isFixed ? 30 : null;
    const { label, cat } = friendlyLabel(dueDate, todayIso);

    const suggestedDay: PlanItem["suggestedDay"] =
      cat === "overdue" || cat === "today" || priority === "high" ? "today" : "today";

    // Clean title
    const title = line.replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?/i, "").replace(/\s+/g, " ").trim();

    return {
      originalIndex: i,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      durationMinutes: duration,
      priority,
      reason: isFixed ? "Fixed commitment at a specific time." : priority === "high" ? "Time-sensitive or high-consequence." : "Keeps your day on track.",
      dueDate,
      dueLabel: label,
      dueCategory: cat,
      suggestedDay,
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
    const todayIso = data.nowIso.slice(0, 10);

    if (!key) {
      return { items: deterministicFallback(data.tasks, data.nowIso), usedFallback: true };
    }

    try {
      const gateway = createLovableAiGatewayProvider(key);
      const userPrompt = `Current local datetime: ${data.nowIso}
Timezone: ${data.timezone}
Available until (today): ${data.availableUntil}

Input lines (one item per line, 0-indexed):
${data.tasks.map((t, i) => `${i}: ${t}`).join("\n")}

Return the JSON array now.`;

      const { text } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        system: SYSTEM,
        prompt: userPrompt,
      });

      const cleaned = stripFences(text);
      const parsed = JSON.parse(cleaned) as PlanItem[];
      // Recompute due labels using today's date to keep them fresh
      const normalized = parsed.map((p) => {
        const { label, cat } = friendlyLabel(p.dueDate ?? null, todayIso);
        return { ...p, dueLabel: label ?? p.dueLabel ?? null, dueCategory: cat };
      });
      return { items: normalized, usedFallback: false };
    } catch (err) {
      console.error("AI planning failed, using fallback:", err);
      return { items: deterministicFallback(data.tasks, data.nowIso), usedFallback: true };
    }
  });
