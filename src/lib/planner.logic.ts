import type { PlanItem } from "./planner.types";

const REQUIRED_TODAY_PATTERNS = [
  /\bmust\s+(?:do|finish|complete|submit|handle|get)\b[^.!?\n]*(?:\btoday\b|\btonight\b|\bbefore\s+bed\b)/i,
  /\bhave\s+to\s+(?:do|finish|complete|submit|handle|get)\b[^.!?\n]*(?:\btoday\b|\btonight\b|\bbefore\s+bed\b)/i,
  /\bneed\s+to\s+finish\b[^.!?\n]*(?:\btonight\b|\bbefore\s+bed\b)/i,
  /\bdue\s+tonight\b/i,
  /\bbefore\s+bed\b/i,
  /\bcannot\s+wait\s+(?:until|till)\s+tomorrow\b/i,
  /\bcan(?:'|\u2019)?t\s+wait\s+(?:until|till)\s+tomorrow\b/i,
  /\b(?:has|have)\s+to\s+be\s+done\s+tonight\b/i,
  /\bmust\s+be\s+done\s+(?:today|tonight)\b/i,
];

const MATCH_IGNORED_WORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "before",
  "by",
  "do",
  "done",
  "finish",
  "for",
  "has",
  "have",
  "i",
  "it",
  "must",
  "need",
  "of",
  "on",
  "the",
  "this",
  "to",
  "today",
  "tonight",
  "wait",
  "with",
  "work",
]);

function toMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return 0;
  return hours * 60 + minutes;
}

export interface PlanningWindow {
  todayIso: string;
  nowMinutes: number;
  cutoffMinutes: number;
  availableMinutes: number;
}

/** Computes the same local-day planning window used by the server prompt and timeline. */
export function getPlanningWindow(nowLocalIso: string, availableUntil: string): PlanningWindow {
  const localDateTime = nowLocalIso.slice(0, 16);
  const [date = "", time = "00:00"] = localDateTime.split("T");
  const nowMinutes = toMinutes(time);
  const cutoffMinutes = toMinutes(availableUntil);
  return {
    todayIso: date,
    nowMinutes,
    cutoffMinutes,
    availableMinutes: Math.max(0, cutoffMinutes - nowMinutes),
  };
}

export function hasRequiredTodayLanguage(text: string): boolean {
  return REQUIRED_TODAY_PATTERNS.some((pattern) => pattern.test(text));
}

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => !MATCH_IGNORED_WORDS.has(word)) ?? []
  );
}

function taskMatchesRequiredStatement(item: PlanItem, statement: string): boolean {
  const statementWords = new Set(words(statement));
  const taskWords = words([item.title, item.reason, item.note].filter(Boolean).join(" "));
  // A short imperative title often retains only one meaningful noun from the
  // user's sentence (for example, "Finish the report" -> "Report").
  return taskWords.some((word) => statementWords.has(word));
}

/**
 * Gives explicit same-day language a stable internal meaning after AI extraction.
 * The due date remains untouched: working on something today is not the same as
 * changing when it is actually due.
 */
export function applyPlanningRules(items: PlanItem[], brainDump: string): PlanItem[] {
  const requiredStatements = brainDump
    .split(/[\n.!?;]+/)
    .map((statement) => statement.trim())
    .filter(hasRequiredTodayLanguage);

  return items.map((item) => {
    const requiredToday =
      item.requiredToday === true ||
      hasRequiredTodayLanguage([item.title, item.reason, item.note].filter(Boolean).join(" ")) ||
      requiredStatements.some((statement) => taskMatchesRequiredStatement(item, statement)) ||
      (items.length === 1 && requiredStatements.length > 0);

    if (!requiredToday) return { ...item, requiredToday: false };
    return {
      ...item,
      requiredToday: true,
      priority: "high",
      suggestedDay: "today",
      reason: item.reason || "Clearly needs to be completed today.",
    };
  });
}
