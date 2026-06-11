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
import { MetaForm } from "./meta-form";

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Close, Calendly and Meta are ALL per-user now — every account connects its
  // own and acts on its own data. So this whole page is the signed-in user's
  // own integrations; nothing here is admin-gated. (ElevenLabs/Twilio/OpenAI
  // are a single shared account configured in the server env, not here.)
  const [{ data: integ }, { count: eventTypeCount }] = await Promise.all([
    supabase
      .from("user_integrations")
      .select(
        "calendly_connected_at, calendly_last_sync_at, close_connected_at, meta_connected_at, meta_access_token, meta_last_sync_at, meta_last_sync_count, meta_last_sync_error",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("calendly_event_types")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("active", true),
  ]);

  const closeConnected = Boolean(integ?.close_connected_at);
  const calendlyConnected = Boolean(integ?.calendly_connected_at);
  // meta_access_token is only read to compute `connected`; never sent to the
  // client form.
  const metaConnected = Boolean(
    integ?.meta_connected_at && integ?.meta_access_token,
  );
  const metaLastSyncAt = integ?.meta_last_sync_at ?? null;
  const metaLastSyncCount = integ?.meta_last_sync_count ?? 0;
  const metaLastSyncError = integ?.meta_last_sync_error ?? null;
  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Integrations
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect your own accounts. Each of these is personal to you — your
          campaigns and leads use the accounts you connect here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <IntegrationCard
          title="Meta Ads (Facebook / Instagram)"
          description="Sync the emails of leads you own into your own Meta Custom Audience for ads and lookalikes. Emails are hashed before they leave the server."
          connected={metaConnected}
          subtitle={
            metaConnected && metaLastSyncAt
              ? `Last synced ${formatCreatedAt(metaLastSyncAt, now)}`
              : metaConnected
                ? "Connected"
                : undefined
          }
          delay={75}
        >
          <MetaForm
            connected={metaConnected}
            lastSyncAt={metaLastSyncAt}
            lastSyncCount={metaLastSyncCount}
            lastSyncError={metaLastSyncError}
          />
        </IntegrationCard>

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
