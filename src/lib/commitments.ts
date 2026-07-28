export interface WeeklyCommitment {
  id: string;
  name: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  enabled: boolean;
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
