import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

/**
 * Service-role Supabase client. Bypasses RLS — server-only.
 * Never import this into client components.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
