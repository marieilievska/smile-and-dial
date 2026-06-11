import "server-only";

import { createClient } from "@supabase/supabase-js";

import { ID_CHUNK, chunk } from "@/lib/leads/chunk";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

/** Remove stored recordings (object paths, not legacy http URLs) for the given
 *  calls from the private bucket. Best-effort. */
export async function removeCallRecordings(
  admin: Admin,
  callIds: string[],
): Promise<void> {
  for (const ids of chunk(callIds, ID_CHUNK)) {
    const { data: rows } = await admin
      .from("calls")
      .select("recording_path")
      .in("id", ids);
    const objects = (rows ?? [])
      .map((r) => r.recording_path)
      .filter(
        (p): p is string => Boolean(p) && !/^https?:\/\//i.test(p as string),
      );
    if (objects.length > 0) {
      await admin.storage.from("call-recordings").remove(objects);
    }
  }
}

/** Permanently delete calls: remove their recordings, then delete the rows
 *  (chunked). Returns an error string on the first failed delete. */
export async function hardDeleteCalls(
  admin: Admin,
  callIds: string[],
): Promise<{ error: string | null }> {
  const clean = [...new Set(callIds.filter(Boolean))];
  if (clean.length === 0) return { error: null };
  await removeCallRecordings(admin, clean);
  for (const ids of chunk(clean, ID_CHUNK)) {
    const { error } = await admin.from("calls").delete().in("id", ids);
    if (error) return { error: "Could not delete calls." };
  }
  return { error: null };
}
