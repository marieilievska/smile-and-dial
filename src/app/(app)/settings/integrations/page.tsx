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
  // ElevenLabs/Twilio/OpenAI are global (admin-managed via env). Close +
  // Calendly are PER-USER — every rep connects their own, so this page is
  // open to all signed-in users; only the ElevenLabs card is admin-only.
  const isAdmin = me?.role === "admin";

  const [{ data: integ }, { count: eventTypeCount }] = await Promise.all([
    supabase
      .from("user_integrations")
      .select(
        "calendly_connected_at, calendly_last_sync_at, close_connected_at",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("calendly_event_types")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("active", true),
  ]);

  let voiceIds = "";
  if (isAdmin) {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("elevenlabs_voice_ids")
      .eq("id", 1)
      .maybeSingle();
    voiceIds = settings?.elevenlabs_voice_ids ?? "";
  }

  // Round L1 — the ElevenLabs API key now lives in the server env, so
  // "connected" is true whenever the deployment has the env var set.
  const elevenLabsConnected = Boolean(process.env.ELEVENLABS_API_KEY?.trim());
  const closeConnected = Boolean(integ?.close_connected_at);
  const calendlyConnected = Boolean(integ?.calendly_connected_at);
  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Integrations
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect Smile &amp; Dial to the services it relies on.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {isAdmin ? (
          <IntegrationCard
            title="ElevenLabs"
            description="The voice AI that powers calls. The voice IDs listed here are the ones available when building an agent."
            connected={elevenLabsConnected}
            subtitle={
              elevenLabsConnected
                ? "API key in server env"
                : "Set ELEVENLABS_API_KEY in the server env"
            }
            delay={75}
          >
            <ElevenLabsForm voiceIds={voiceIds} />
          </IntegrationCard>
        ) : null}

        <IntegrationCard
          title="Close"
          description="Email gateway. Connect to enable the send_email agent tool and to receive email_replied notifications when a lead writes back."
          connected={closeConnected}
          subtitle={
            closeConnected && integ?.close_connected_at
              ? `Connected ${formatCreatedAt(integ.close_connected_at, now)}`
              : undefined
          }
          delay={150}
        >
          <CloseForm
            connected={closeConnected}
            connectedAt={integ?.close_connected_at ?? null}
          />
        </IntegrationCard>

        <IntegrationCard
          title="Calendly"
          description="Connect Calendly to enable agent appointment booking and to auto-flip leads into the goal pipeline when an invitee schedules."
          connected={calendlyConnected}
          subtitle={
            calendlyConnected && integ?.calendly_last_sync_at
              ? `Last sync ${formatCreatedAt(integ.calendly_last_sync_at, now)}`
              : calendlyConnected
                ? "Connected"
                : undefined
          }
          delay={225}
        >
          <CalendlyForm
            connected={calendlyConnected}
            lastSyncAt={integ?.calendly_last_sync_at ?? null}
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
