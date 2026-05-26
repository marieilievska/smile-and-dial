import { redirect } from "next/navigation";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

import { CalendlyForm } from "./calendly-form";
import { ElevenLabsForm } from "./elevenlabs-form";

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const [{ data: settings }, { count: eventTypeCount }] = await Promise.all([
    supabase
      .from("app_settings")
      .select(
        "elevenlabs_api_key, elevenlabs_voice_ids, calendly_connected_at, calendly_last_sync_at",
      )
      .eq("id", 1)
      .maybeSingle(),
    supabase
      .from("calendly_event_types")
      .select("id", { count: "exact", head: true })
      .eq("active", true),
  ]);

  return (
    <div className="p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Integrations
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect Smile &amp; Dial to the services it relies on.
        </p>
      </div>

      <Card className="mt-6 max-w-2xl">
        <CardHeader>
          <CardTitle>ElevenLabs</CardTitle>
          <CardDescription>
            The voice AI that powers calls. The voice IDs listed here are the
            ones available when building an agent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ElevenLabsForm
            hasApiKey={Boolean(settings?.elevenlabs_api_key)}
            voiceIds={settings?.elevenlabs_voice_ids ?? ""}
          />
        </CardContent>
      </Card>

      <Card className="mt-6 max-w-2xl">
        <CardHeader>
          <CardTitle>Calendly</CardTitle>
          <CardDescription>
            Connect Calendly to enable agent appointment booking and to
            auto-flip leads into the goal pipeline when an invitee schedules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CalendlyForm
            connected={Boolean(settings?.calendly_connected_at)}
            lastSyncAt={settings?.calendly_last_sync_at ?? null}
            eventTypeCount={eventTypeCount ?? 0}
          />
        </CardContent>
      </Card>
    </div>
  );
}
