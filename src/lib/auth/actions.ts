"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type LoginState = { error: string } | null;

/** Server action: sign in with email and password. */
export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: "Incorrect email or password." };
  }

  redirect("/leads");
}

/** Server action: sign out of this session and return to the login page. */
export async function signOut() {
  const supabase = await createClient();
  // Local scope: sign out of this browser only, not every device.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
