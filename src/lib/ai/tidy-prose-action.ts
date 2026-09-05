"use server";

import { createClient } from "@/lib/supabase/server";

import { tidyProse } from "./tidy-prose";

/**
 * Server action behind the agent builder's "Tidy" button.
 *
 * The builder is a client component, and the OpenAI key is a server-only
 * env var — so calling `tidyProse` directly from the browser never had a key
 * and quietly returned the text unchanged. Routing it through a server action
 * makes the button work AND lets the spend be booked to the signed-in user in
 * `ai_charges`. Unauthenticated callers get their text back untouched.
 */
export async function tidyProseAction(text: string): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return text;
  return tidyProse(text, { ownerId: user.id });
}
