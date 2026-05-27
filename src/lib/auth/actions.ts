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

  redirect("/today");
}

/** Server action: sign out of this session and return to the login page. */
export async function signOut() {
  const supabase = await createClient();
  // Local scope: sign out of this browser only, not every device.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

export type ForgotPasswordState =
  | { kind: "idle" }
  | { kind: "error"; error: string }
  | { kind: "sent" }
  | null;

/** Server action: send a Supabase password-reset email. We never
 *  reveal whether the address exists (Supabase intentionally returns
 *  ok regardless to prevent account enumeration), so the success
 *  state is identical for any address. */
export async function forgotPassword(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { kind: "error", error: "Email is required." };
  }

  const supabase = await createClient();

  // The reset link arrives via email and lands on /auth/confirm, which
  // exchanges the token for a session, then redirects to
  // /auth/set-password — the same page the invite flow uses.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm?next=/auth/set-password`,
  });

  if (error) {
    // Network / 5xx — show a generic error. Otherwise treat as sent
    // even if Supabase says no-such-user, to avoid enumeration.
    if (error.status && error.status >= 500) {
      return {
        kind: "error",
        error: "Something went wrong. Try again in a minute.",
      };
    }
  }

  return { kind: "sent" };
}

export type SetPasswordState = { error: string } | null;

/**
 * Server action: set the signed-in user's password. Used after an invite or
 * password-reset link establishes a session via /auth/confirm.
 */
export async function setPassword(
  _prevState: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "The passwords do not match." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Your link has expired. Please request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: "Could not set your password. Please try again." };
  }

  redirect("/today");
}
