/** One registration, reduced to the fields that decide whether a pipeline mark
 *  belongs to it. Kept free of the `server-only` import so it unit-tests
 *  cleanly, in the same spirit as calendly/booking.ts. */
export type MarkableRegistration = {
  id: string;
  scheduled_at: string | null;
  attended_at: string | null;
};

/**
 * Which of a lead's registrations a pipeline mark (attended / sale) applies to.
 *
 * The most recent session that has ALREADY STARTED and is still unmarked. That
 * is what the operator means when she marks someone after a webinar: "the one
 * that just happened". Picking the earliest instead would mis-assign the mark
 * for someone who no-showed once and came back — the exact case that made
 * storing the outcome on the lead untenable, since `leads.status` holds only
 * current state and a second visit overwrites the first.
 *
 * Returns null when nothing qualifies — no registrations, all still upcoming,
 * or all already marked. Callers should treat that as "leave the registration
 * alone": a lead can be moved through the pipeline for reasons that have
 * nothing to do with a session.
 */
export function pickRegistrationToMark<T extends MarkableRegistration>(
  registrations: readonly T[],
  now: Date = new Date(),
): T | null {
  const startedAt = (r: MarkableRegistration): number => {
    if (r.scheduled_at === null) return Number.NaN;
    return new Date(r.scheduled_at).getTime();
  };

  const started = registrations.filter((r) => {
    if (r.attended_at !== null) return false;
    const t = startedAt(r);
    // NaN comparisons are always false, so an unparseable date drops out here
    // rather than throwing or sorting unpredictably.
    return !Number.isNaN(t) && t <= now.getTime();
  });

  if (started.length === 0) return null;
  return started.reduce((latest, r) =>
    startedAt(r) > startedAt(latest) ? r : latest,
  );
}
