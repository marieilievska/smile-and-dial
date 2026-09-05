/**
 * The retention window for call audio and transcripts. Pure helpers shared by
 * the nightly sweep (server) and the call-detail modal (client), so the two
 * can never disagree on what "older than 90 days" means.
 *
 * Product decision (2026-09-05): audio files and transcript text stay in OUR
 * storage/database for 90 days, then are removed from our side. The call row
 * itself — outcome, summary, extracted data, objection fields, cost — is kept
 * forever. Older audio/transcripts remain in the ElevenLabs dashboard (the
 * agent's ElevenLabs retention is unlimited).
 */

export const RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The instant before which audio/transcripts are eligible for removal. */
export function retentionCutoff(
  days: number = RETENTION_DAYS,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/** True when a call created at `createdAt` is past the retention window —
 *  i.e. the sweep has (or will have) removed its audio and transcript. Null,
 *  missing, or unparseable timestamps are treated as NOT past retention so
 *  the UI never claims data was pruned when it can't actually tell. */
export function isPastRetention(
  createdAt: string | null | undefined,
  opts: { days?: number; now?: Date } = {},
): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return t < retentionCutoff(opts.days, opts.now).getTime();
}

/** A recording_path is a storage object key (something we must delete from
 *  the `call-recordings` bucket) unless it is a full http(s) URL — legacy
 *  human-call rows kept a Twilio-hosted URL, which we don't own and can't
 *  delete. Same test `removeCallRecordings` in delete-calls-core applies. */
export function isStorageObjectPath(path: string): boolean {
  return path.length > 0 && !/^https?:\/\//i.test(path);
}

export type RecordingRow = { id: string; recording_path: string | null };

/** Split a batch of calls into the storage objects to remove and the call ids
 *  whose recording_path should be nulled. Every row with a non-null path is
 *  nulled (legacy URL rows included, and an empty-string path too — otherwise
 *  it would be re-selected every night and never converge); only real object
 *  keys go to the bucket. Duplicate keys collapse so one object is never sent
 *  twice in the same remove() call. */
export function partitionRecordingRows(rows: RecordingRow[]): {
  storagePaths: string[];
  callIds: string[];
} {
  const storagePaths = new Set<string>();
  const callIds: string[] = [];
  for (const row of rows) {
    const path = row.recording_path;
    if (path == null) continue;
    callIds.push(row.id);
    if (isStorageObjectPath(path)) storagePaths.add(path);
  }
  return { storagePaths: [...storagePaths], callIds };
}
