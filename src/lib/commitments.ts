export interface WeeklyCommitment {
  id: string;
  name: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  enabled: boolean;
}

export interface CommitmentEventGroup<T extends WeeklyCommitment = WeeklyCommitment> {
  key: string;
  name: string;
  start_time: string;
  end_time: string;
  commitments: T[];
  days: number[];
  activeDays: number;
  totalDays: number;
  allEnabled: boolean;
}

export function groupCommitmentsByWeek<T extends WeeklyCommitment>(
  commitments: T[],
): Record<number, T[]> {
  const grouped: Record<number, T[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const commitment of commitments) {
    for (const day of commitment.days_of_week) {
      if (grouped[day]) grouped[day].push(commitment);
    }
  }
  return grouped;
}

export function groupCommitmentsByEvent<T extends WeeklyCommitment>(
  commitments: T[],
): CommitmentEventGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const commitment of commitments) {
    const key = `${commitment.name}\u0000${commitment.start_time}\u0000${commitment.end_time}`;
    groups.set(key, [...(groups.get(key) ?? []), commitment]);
  }

  return [...groups.entries()].map(([key, matchingCommitments]) => {
    const enabledByDay = new Map<number, boolean>();
    for (const commitment of matchingCommitments) {
      for (const day of commitment.days_of_week) {
        enabledByDay.set(day, (enabledByDay.get(day) ?? false) || commitment.enabled);
      }
    }
    const days = [...enabledByDay.keys()].sort((a, b) => a - b);
    const activeDays = days.filter((day) => enabledByDay.get(day)).length;
    const first = matchingCommitments[0];

    return {
      key,
      name: first.name,
      start_time: first.start_time,
      end_time: first.end_time,
      commitments: matchingCommitments,
      days,
      activeDays,
      totalDays: days.length,
      allEnabled: activeDays === days.length,
    };
  });
}

export function setCommitmentGroupEnabled<T extends WeeklyCommitment>(
  commitments: T[],
  commitmentIds: string[],
  enabled: boolean,
): T[] {
  const matchingIds = new Set(commitmentIds);
  return commitments.map((commitment) =>
    matchingIds.has(commitment.id) ? { ...commitment, enabled } : commitment,
  );
}

export function setCommitmentOccurrenceEnabled<T extends WeeklyCommitment>(
  commitments: T[],
  commitmentId: string,
  day: number,
  enabled: boolean,
  occurrence: T,
): T[] {
  return commitments.flatMap((commitment) => {
    if (commitment.id !== commitmentId || !commitment.days_of_week.includes(day)) {
      return [commitment];
    }

    if (commitment.days_of_week.length === 1) {
      return [{ ...commitment, enabled }];
    }

    return [
      {
        ...commitment,
        days_of_week: commitment.days_of_week.filter((weekday) => weekday !== day),
      },
      occurrence,
    ];
  });
}
