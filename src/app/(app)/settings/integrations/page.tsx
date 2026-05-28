import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

import { formatCreatedAt } from "../format-created";
import { CalendlyForm } from "./calendly-form";
import { CloseForm } from "./close-form";
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
        "elevenlabs_api_key, elevenlabs_voice_ids, calendly_connected_at, calendly_last_sync_at, close_connected_at",
      )
      .eq("id", 1)
      .maybeSingle(),
    supabase
      .from("calendly_event_types")
      .select("id", { count: "exact", head: true })
      .eq("active", true),
  ]);

  const elevenLabsConnected = Boolean(settings?.elevenlabs_api_key);
  const closeConnected = Boolean(settings?.close_connected_at);
  const calendlyConnected = Boolean(settings?.calendly_connected_at);
  const now = new Date();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Integrations
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect Smile &amp; Dial to the services it relies on.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <IntegrationCard
          title="ElevenLabs"
          description="The voice AI that powers calls. The voice IDs listed here are the ones available when building an agent."
          connected={elevenLabsConnected}
          subtitle={elevenLabsConnected ? "API key on file" : undefined}
          delay={75}
        >
          <ElevenLabsForm
            hasApiKey={elevenLabsConnected}
            voiceIds={settings?.elevenlabs_voice_ids ?? ""}
          />
        </IntegrationCard>

        <IntegrationCard
          title="Close"
          description="Email gateway. Connect to enable the send_email agent tool and to receive email_replied notifications when a lead writes back."
          connected={closeConnected}
          subtitle={
            closeConnected && settings?.close_connected_at
              ? `Connected ${formatCreatedAt(settings.close_connected_at, now)}`
              : undefined
          }
          delay={150}
        >
          <CloseForm
            connected={closeConnected}
            connectedAt={settings?.close_connected_at ?? null}
          />
        </IntegrationCard>

        <IntegrationCard
          title="Calendly"
          description="Connect Calendly to enable agent appointment booking and to auto-flip leads into the goal pipeline when an invitee schedules."
          connected={calendlyConnected}
          subtitle={
            calendlyConnected && settings?.calendly_last_sync_at
              ? `Last sync ${formatCreatedAt(settings.calendly_last_sync_at, now)}`
              : calendlyConnected
                ? "Connected"
                : undefined
          }
          delay={225}
        >
          <CalendlyForm
            connected={calendlyConnected}
            lastSyncAt={settings?.calendly_last_sync_at ?? null}
            eventTypeCount={eventTypeCount ?? 0}
          />
        </IntegrationCard>
      </div>
    </div>
  );
}

function IntegrationCard({
  title,
  description,
  connected,
  subtitle,
  children,
  delay,
}: {
  title: string;
  description: string;
  connected: boolean;
  subtitle?: string;
  children: React.ReactNode;
  delay: number;
}) {
  return (
    <Card
      className="duration-500"
      style={{ animationDelay: `${delay}ms` }}
      data-testid="integration-card"
      data-integration={title}
      data-connected={connected ? "true" : "false"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Badge variant={connected ? "success" : "ghost"} dot>
            {connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        {subtitle ? (
          <p className="text-muted-foreground mt-2 text-xs">{subtitle}</p>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
