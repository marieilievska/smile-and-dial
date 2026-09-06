import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import { getCloseMe, listCloseSmsNumbers } from "./api";
import { pickSmsFromNumber, type CloseSmsNumber } from "./sms-from-number";

type ServiceClient = SupabaseClient<Database>;

export type SyncCloseSmsNumbersResult =
  | { ok: true; numbers: CloseSmsNumber[]; fromNumber: string | null }
  | { ok: false; error: string };

/** Read the SMS-capable numbers from the user's Close account, choose the one
 *  to text from (pickSmsFromNumber) and persist both on user_integrations.
 *
 *  Shared by connect, "Refresh numbers", and the send_text tool's one live
 *  attempt when nothing is stored yet. `current` is the choice already on the
 *  row (kept when still valid). Never throws: a Close outage returns
 *  {ok:false} and leaves the stored columns alone, so a refresh can't wipe a
 *  working number. */
export async function syncCloseSmsNumbers(
  admin: ServiceClient,
  input: { userId: string; apiKey: string; current: string | null },
): Promise<SyncCloseSmsNumbersResult> {
  let numbers: CloseSmsNumber[] | null;
  let me: { id: string } | null;
  try {
    [numbers, me] = await Promise.all([
      listCloseSmsNumbers(input.apiKey),
      getCloseMe(input.apiKey),
    ]);
  } catch {
    return { ok: false, error: "Close request failed." };
  }
  if (!numbers)
    return { ok: false, error: "Couldn't read numbers from Close." };

  const fromNumber = pickSmsFromNumber(numbers, {
    closeUserId: me?.id ?? null,
    current: input.current,
  });
  const { error } = await admin
    .from("user_integrations")
    .update({
      close_sms_numbers: numbers as unknown as Json,
      close_sms_from_number: fromNumber,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", input.userId);
  if (error) return { ok: false, error: "Couldn't save the numbers." };
  return { ok: true, numbers, fromNumber };
}
