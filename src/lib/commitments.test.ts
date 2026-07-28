import { describe, expect, it } from "vitest";
import { setCommitmentOccurrenceEnabled, type WeeklyCommitment } from "./commitments";

describe("weekly commitment occurrences", () => {
  it("disables only Monday's AI Class while Tuesday through Friday remain enabled", () => {
    const aiClass: WeeklyCommitment = {
      id: "ai-class-weekdays",
      name: "AI Class",
      days_of_week: [1, 2, 3, 4, 5],
      start_time: "16:30",
      end_time: "19:00",
      enabled: true,
    };
    const disabledMonday: WeeklyCommitment = {
      ...aiClass,
      id: "ai-class-monday",
      days_of_week: [1],
      enabled: false,
    };

    const result = setCommitmentOccurrenceEnabled([aiClass], aiClass.id, 1, false, disabledMonday);
    const enabledByDay = Object.fromEntries(
      result.flatMap((commitment) =>
        commitment.days_of_week.map((day) => [day, commitment.enabled]),
      ),
    );

    expect(enabledByDay).toEqual({
      1: false,
      2: true,
      3: true,
      4: true,
      5: true,
    });
  });

  it("re-enables only the selected single-day occurrence", () => {
    const monday: WeeklyCommitment = {
      id: "ai-class-monday",
      name: "AI Class",
      days_of_week: [1],
      start_time: "16:30",
      end_time: "19:00",
      enabled: false,
    };
    const tuesday: WeeklyCommitment = {
      ...monday,
      id: "ai-class-tuesday",
      days_of_week: [2],
    };

    const result = setCommitmentOccurrenceEnabled([monday, tuesday], monday.id, 1, true, {
      ...monday,
      enabled: true,
    });

    expect(result.find((commitment) => commitment.id === monday.id)?.enabled).toBe(true);
    expect(result.find((commitment) => commitment.id === tuesday.id)?.enabled).toBe(false);
  });
});
