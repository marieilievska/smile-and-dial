import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { mintVoiceToken } from "@/lib/twilio/voice-token";

/**
 * Returns a short-lived Twilio Voice access token for the logged-in user so
 * their browser can place a human call. Identity = the user's id, which the
 * dial handler echoes back on the call params.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const token = mintVoiceToken({ identity: user.id });
    return NextResponse.json({ token, identity: user.id });
  } catch {
    return NextResponse.json(
      { error: "Browser calling is not configured." },
      { status: 503 },
    );
  }
}
