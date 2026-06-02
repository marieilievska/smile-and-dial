import { CircleAlert, CircleCheck, Phone } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";
import { appWebhookUrls } from "@/lib/twilio/numbers";

import { formatCreatedAt } from "../format-created";
import { BuyNumberDialog } from "./buy-number-dialog";
import { DeleteNumberDialog } from "./delete-number-dialog";
import { ReleaseNumberDialog } from "./release-number-dialog";
import { RepointWebhooksButton } from "./repoint-button";
import { TwilioNumbersStatusTabs } from "./status-tabs";
import { TwilioSyncButton } from "./sync-button";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function TwilioNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
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

  const params = await searchParams;
  const status = ["all", "in_pool", "released"].includes(str(params.status))
    ? str(params.status)
    : "all";

  const { data: rawNumbers } = await supabase
    .from("twilio_numbers")
    .select(
      "id, phone_number, friendly_name, country, monthly_cost, released_at, purchased_at, voice_webhook_url, status_webhook_url",
    )
    .order("purchased_at", { ascending: false });
  const numbers = rawNumbers ?? [];

  // The webhook URLs we *expect* every number to be set to, based on
  // this deployment's NEXT_PUBLIC_APP_URL. Used to render an
  // "ok / mismatch / unset" indicator in the Webhooks column. Null
  // means the env var isn't set on this deployment.
  const expectedWebhooks = appWebhookUrls();

  const counts = {
    all: numbers.length,
    in_pool: numbers.filter((n) => !n.released_at).length,
    released: numbers.filter((n) => n.released_at).length,
  };
  const visible = numbers.filter((n) => {
    if (status === "in_pool") return !n.released_at;
    if (status === "released") return Boolean(n.released_at);
    return true;
  });

  function buildStatusHref(next: string): string {
    const url = new URLSearchParams();
    if (next && next !== "all") url.set("status", next);
    const qs = url.toString();
    return qs ? `/settings/twilio-numbers?${qs}` : "/settings/twilio-numbers";
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Twilio numbers
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The pool of phone numbers your campaigns dial from.
          </p>
        </div>
        {/* Round L2 — Sync sits to the left of Buy. The two buttons
         *  read as a pair: "Buy a new number" vs "Pull in whatever
         *  Twilio already has on file." */}
        <div className="flex items-center gap-2">
          <TwilioSyncButton />
          <BuyNumberDialog />
        </div>
      </div>

      {numbers.length > 0 ? (
        <>
          {/* Round 29 — dropped the stat strip. The status tabs below
           *  carry the In pool / Released split with per-tab counts,
           *  and the monthly cost wasn't urgent enough to chrome up
           *  every settings visit with it. */}
          <TwilioNumbersStatusTabs
            current={status}
            counts={counts}
            buildHref={buildStatusHref}
          />

          {visible.length > 0 ? (
            <div className="border-border overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Friendly name</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Monthly cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Webhooks</TableHead>
                    <TableHead>Purchased</TableHead>
                    <TableHead className="w-48" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((number) => (
                    <TableRow key={number.id} className="group">
                      {/* Round 34 — phones in this admin table stay as
                       *  E.164 so the test contract (`getByRole("row",
                       *  { name: phone })`) keeps resolving. The
                       *  user-facing lists (/leads, /calls, /callbacks,
                       *  /goals, /dnc, global search) use formatPhone
                       *  for human-readability. */}
                      <TableCell className="font-mono text-xs font-medium">
                        {number.phone_number}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {number.friendly_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {number.country}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        ~${Number(number.monthly_cost).toFixed(2)}/mo
                      </TableCell>
                      <TableCell>
                        {number.released_at ? (
                          <Badge variant="ghost" dot>
                            Released
                          </Badge>
                        ) : (
                          <Badge variant="success" dot>
                            In pool
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <WebhookStatus
                          voice={number.voice_webhook_url}
                          status={number.status_webhook_url}
                          expected={expectedWebhooks}
                          released={Boolean(number.released_at)}
                        />
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground tabular-nums"
                        title={new Date(number.purchased_at).toLocaleString()}
                      >
                        {formatCreatedAt(number.purchased_at, now)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          {number.released_at ? (
                            <DeleteNumberDialog
                              number={{
                                id: number.id,
                                phone_number: number.phone_number,
                              }}
                            />
                          ) : (
                            <>
                              <RepointWebhooksButton id={number.id} />
                              <ReleaseNumberDialog
                                number={{
                                  id: number.id,
                                  phone_number: number.phone_number,
                                }}
                              />
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
              <Phone className="text-muted-foreground size-8" />
              <p className="text-foreground text-sm font-medium">
                No numbers in this view
              </p>
              <p className="text-muted-foreground text-sm">
                Switch to another tab to see released or all numbers.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Phone className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No numbers yet</p>
          <p className="text-muted-foreground text-sm">
            Buy your first phone number to start building campaigns.
          </p>
        </div>
      )}
    </div>
  );
}

/** Round L2 — small visual indicator for the Webhooks column. Three
 *  states matter to the operator:
 *    · "Pointed here"   — both URLs match the deployment's expected
 *                          values. Green check, no action needed.
 *    · "Pointed elsewhere" — Twilio has SOME URL on file, but it's
 *                          not us. Amber. The "Point webhooks"
 *                          button in the row actions fixes it.
 *    · "Not set"        — Twilio has nothing configured (or the
 *                          sync hasn't run yet). Muted dash.
 *    · "Released"       — short-circuit muted dash; the column is
 *                          irrelevant for released numbers.
 *  When the deployment doesn't have NEXT_PUBLIC_APP_URL set, we
 *  can't compute "ok / mismatch" so we say "deployment URL
 *  missing." */
function WebhookStatus({
  voice,
  status,
  expected,
  released,
}: {
  voice: string | null;
  status: string | null;
  expected: { voiceUrl: string; statusCallback: string } | null;
  released: boolean;
}) {
  if (released) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  if (!expected) {
    return (
      <span
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
        title="NEXT_PUBLIC_APP_URL isn't set on this deployment."
      >
        <CircleAlert className="size-3.5" />
        Deployment URL missing
      </span>
    );
  }
  if (!voice && !status) {
    return (
      <span
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
        title="Hit Sync to refresh from Twilio, or Point webhooks to wire this number."
      >
        <CircleAlert className="size-3.5" />
        Not set
      </span>
    );
  }
  const voiceMatch = voice === expected.voiceUrl;
  const statusMatch = status === expected.statusCallback;
  if (voiceMatch && statusMatch) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"
        title={`Voice → ${expected.voiceUrl}\nStatus → ${expected.statusCallback}`}
      >
        <CircleCheck className="size-3.5" />
        Pointed here
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
      title={[
        `Voice → ${voice ?? "(unset)"} (expected ${expected.voiceUrl})`,
        `Status → ${status ?? "(unset)"} (expected ${expected.statusCallback})`,
      ].join("\n")}
    >
      <CircleAlert className="size-3.5" />
      Pointed elsewhere
    </span>
  );
}
