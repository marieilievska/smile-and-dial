import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

/**
 * Register a completed call for review. A human-reached call is queued
 * (status='pending') for the worker; a non-conversation is closed immediately
 * with the `no_conversation` flag so it shows in a cheap bucket without an LLM.
 * Idempotent: upsert on the call_id PK.
 */
export async function enqueueCallReview(
  admin: Admin,
  input: { callId: string; reachedHuman: boolean },
): Promise<void> {
  await admin.from("call_reviews").upsert(
    {
      call_id: input.callId,
      reached_human: input.reachedHuman,
      status: input.reachedHuman ? "pending" : "done",
      analyzed_at: input.reachedHuman ? null : new Date().toISOString(),
    },
    { onConflict: "call_id", ignoreDuplicates: true },
  );
  if (!input.reachedHuman) {
    await admin
      .from("call_review_flags")
      .upsert(
        {
          call_id: input.callId,
          flag_key: "no_conversation",
          status: "confirmed",
        },
        { onConflict: "call_id,flag_key", ignoreDuplicates: true },
      );
  }
}
