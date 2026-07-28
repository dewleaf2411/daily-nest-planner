import { describe, expect, it } from "vitest";
import {
  groupCommitmentsByEvent,
  groupCommitmentsByWeek,
  setCommitmentGroupEnabled,
  setCommitmentOccurrenceEnabled,
  type WeeklyCommitment,
} from "./commitments";

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

  it("updates the By event active-day count when one day is disabled in By week", () => {
    const aiClass: WeeklyCommitment = {
      id: "ai-class-weekdays",
      name: "AI Class",
      days_of_week: [1, 2, 3, 4, 5],
      start_time: "16:30",
      end_time: "19:00",
      enabled: true,
    };
    const disabledMonday = { ...aiClass, id: "ai-class-monday", days_of_week: [1], enabled: false };
    const afterWeekToggle = setCommitmentOccurrenceEnabled(
      [aiClass],
      aiClass.id,
      1,
      false,
      disabledMonday,
    );

    expect(groupCommitmentsByEvent(afterWeekToggle)[0]).toEqual(
      expect.objectContaining({ activeDays: 4, totalDays: 5, allEnabled: false }),
    );
  });

  it("Disable all affects every matching weekday occurrence", () => {
    const commitments = makeSplitAiClass();
    const ids = commitments.map((commitment) => commitment.id);
    const disabled = setCommitmentGroupEnabled(commitments, ids, false);

    expect(disabled.every((commitment) => !commitment.enabled)).toBe(true);
    expect(groupCommitmentsByEvent(disabled)[0].activeDays).toBe(0);
  });

  it("Enable all restores every matching weekday occurrence", () => {
    const commitments = makeSplitAiClass().map((commitment) => ({
      ...commitment,
      enabled: false,
    }));
    const ids = commitments.map((commitment) => commitment.id);
    const enabled = setCommitmentGroupEnabled(commitments, ids, true);

    expect(enabled.every((commitment) => commitment.enabled)).toBe(true);
    expect(groupCommitmentsByEvent(enabled)[0]).toEqual(
      expect.objectContaining({ activeDays: 5, totalDays: 5, allEnabled: true }),
    );
  });

  it("switching between grouped views does not lose occurrence changes", () => {
    const commitments = makeSplitAiClass();
    const changed = setCommitmentGroupEnabled(commitments, ["ai-class-1"], false);

    const eventViewBefore = groupCommitmentsByEvent(changed);
    const weekView = groupCommitmentsByWeek(changed);
    const eventViewAfter = groupCommitmentsByEvent(changed);

    expect(weekView[1][0].enabled).toBe(false);
    expect(weekView[2][0].enabled).toBe(true);
    expect(eventViewAfter).toEqual(eventViewBefore);
    expect(eventViewAfter[0].activeDays).toBe(4);
  });
});

function makeSplitAiClass(): WeeklyCommitment[] {
  return [1, 2, 3, 4, 5].map((day) => ({
    id: `ai-class-${day}`,
    name: "AI Class",
    days_of_week: [day],
    start_time: "16:30",
    end_time: "19:00",
    enabled: true,
  }));
}
