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
import {
  effectiveDailyCap,
  loadPoolSettings,
  UNCAPPED,
  type PoolSettings,
} from "@/lib/dialer/number-pool";
import { stateForAreaCode } from "@/lib/dialer/nanp-states";
import { createClient } from "@/lib/supabase/server";
import { expectedNumberWebhooks } from "@/lib/twilio/numbers";

import { formatCreatedAt } from "../format-created";
import {
  BulkMoveProvider,
  NumberSelectCheckbox,
  SelectAllNumbersCheckbox,
} from "./bulk-move";
import { BuyIntoPoolDialog } from "./buy-into-pool-dialog";
import { BuyNumberDialog } from "./buy-number-dialog";
import { ConnectRateTrend, type DailyStat } from "./connect-rate-trend";
import { DeleteNumberDialog } from "./delete-number-dialog";
import { PoolActionsMenu } from "./pool-actions-menu";
import { ReleaseNumberDialog } from "./release-number-dialog";
import { RenameNumberDialog } from "./rename-number-dialog";
import { ConnectElevenLabsButton } from "./connect-elevenlabs-button";
import { RepointWebhooksButton } from "./repoint-button";
import { TwilioNumbersStatusTabs } from "./status-tabs";
import { TwilioSyncButton } from "./sync-button";
import { etDateTimeExact } from "@/lib/time/eastern";

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
  // Members (builders) manage the number pool; only permanent delete of a
  // released number is admin-only (gated on the Delete control below).
  const isAdmin = me?.role === "admin";

  const params = await searchParams;
  const status = ["all", "in_pool", "released"].includes(str(params.status))
    ? str(params.status)
    : "all";

  const { data: rawNumbers } = await supabase
    .from("twilio_numbers")
    .select(
      "id, phone_number, friendly_name, country, monthly_cost, released_at, purchased_at, voice_webhook_url, status_webhook_url, elevenlabs_phone_number_id, attached_campaign_id, area_code, pool_status, rested_until, flagged_for_rotation, warmup_started_at, last_calls_count_24h, last_connect_rate_24h, daily_cap_override",
    )
    .order("purchased_at", { ascending: false });
  const numbers = rawNumbers ?? [];

  // Campaigns, for the pool-buy dialog's picker and to label each number's
  // "Campaign" column. No soft-delete on campaigns — every row is live.
  const { data: campaignRows } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("name");
  const campaigns = campaignRows ?? [];
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));

  const poolSettings = await loadPoolSettings(supabase);

  const now = new Date();

  // Connect-rate history per number, last 30 Eastern days, oldest first.
  // Recomputed every 30 min by refresh_twilio_number_daily_stats().
  const historySince = new Date(now.getTime() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: statRows } = await supabase
    .from("twilio_number_daily_stats")
    .select("twilio_number_id, day, calls, connected, connect_rate")
    .gte("day", historySince)
    .order("day", { ascending: true });
  const historyByNumber = new Map<string, DailyStat[]>();
  for (const s of statRows ?? []) {
    const list = historyByNumber.get(s.twilio_number_id) ?? [];
    list.push({
      day: s.day,
      calls: s.calls,
      connected: s.connected,
      rate: s.connect_rate == null ? null : Number(s.connect_rate),
    });
    historyByNumber.set(s.twilio_number_id, list);
  }

  // The webhook URLs we *expect* every number to be set to: ElevenLabs' native
  // inbound endpoints (inbound is EL-native). Used to render an
  // "ok / mismatch / unset" indicator in the Webhooks column.
  const expectedWebhooks = expectedNumberWebhooks();

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
  // Only in-pool numbers can be reassigned, so only they get a checkbox and feed
  // the "select all" / bulk-move bar.
  const movableIds = visible.filter((n) => !n.released_at).map((n) => n.id);

  function buildStatusHref(next: string): string {
    const url = new URLSearchParams();
    if (next && next !== "all") url.set("status", next);
    const qs = url.toString();
    return qs ? `/settings/twilio-numbers?${qs}` : "/settings/twilio-numbers";
  }

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
         *  Twilio already has on file." Phase 3b adds "Buy into pool" —
         *  a campaign-targeted buy (area-code planner + auto EL import +
         *  inbound assignment) that sits apart from the plain unattached
         *  buy flow. */}
        <div className="flex items-center gap-2">
          {/* Sync reconciles the whole shared Twilio account, so it's admin-only
           *  (see syncFromTwilio). Members still buy/manage their own numbers. */}
          {isAdmin && <TwilioSyncButton />}
          <BuyIntoPoolDialog campaigns={campaigns} />
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
            // Round 3b — a fixed-width action column plus five new pool
            // columns no longer fits without scrolling on laptop widths;
            // overflow-x-auto lets the table itself scroll instead of
            // squeezing every column.
            <BulkMoveProvider allIds={movableIds} campaigns={campaigns}>
              <div className="border-border overflow-x-auto rounded-2xl border shadow-sm">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-9">
                        <SelectAllNumbersCheckbox />
                      </TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Friendly name</TableHead>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Area</TableHead>
                      <TableHead>Connect rate</TableHead>
                      <TableHead>Country</TableHead>
                      <TableHead>Monthly cost</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Webhooks</TableHead>
                      <TableHead>Purchased</TableHead>
                      <TableHead className="w-[380px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((number) => (
                      <TableRow key={number.id} className="group">
                        <TableCell>
                          <NumberSelectCheckbox
                            id={number.id}
                            phone={number.phone_number}
                            disabled={Boolean(number.released_at)}
                          />
                        </TableCell>
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
                          {number.attached_campaign_id
                            ? (campaignNames.get(number.attached_campaign_id) ??
                              "—")
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {number.area_code ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-foreground tabular-nums">
                                {number.area_code}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                {stateForAreaCode(number.area_code) ?? "—"}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* Was a volume/cap column ("N calls", cap in the
                         *  tooltip). Per-number daily caps are off, so the number
                         *  that matters is no longer "how close to the ceiling"
                         *  but "is this number's connect rate holding up". */}
                        <TableCell>
                          <ConnectRateTrend
                            days={historyByNumber.get(number.id) ?? []}
                            liveRate={number.last_connect_rate_24h}
                            liveCalls={number.last_calls_count_24h}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {number.country}
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">
                          ~${Number(number.monthly_cost).toFixed(2)}/mo
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {number.released_at ? (
                              <Badge variant="ghost" dot>
                                Released
                              </Badge>
                            ) : (
                              <Badge variant="success" dot>
                                In pool
                              </Badge>
                            )}
                            {!number.released_at
                              ? poolStateBadge(
                                  {
                                    pool_status: number.pool_status,
                                    flagged_for_rotation:
                                      number.flagged_for_rotation,
                                    rested_until: number.rested_until,
                                    warmup_started_at: number.warmup_started_at,
                                    daily_cap_override:
                                      number.daily_cap_override,
                                  },
                                  poolSettings,
                                  now,
                                )
                              : null}
                            {!number.released_at &&
                            number.elevenlabs_phone_number_id ? (
                              <Badge variant="secondary">EL ✓</Badge>
                            ) : null}
                          </div>
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
                          title={etDateTimeExact(number.purchased_at)}
                        >
                          {formatCreatedAt(number.purchased_at, now)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            {!number.released_at ? (
                              <PoolActionsMenu
                                campaigns={campaigns}
                                number={{
                                  id: number.id,
                                  pool_status: number.pool_status,
                                  flagged_for_rotation:
                                    number.flagged_for_rotation,
                                  rested_until: number.rested_until,
                                  attached_campaign_id:
                                    number.attached_campaign_id,
                                }}
                              />
                            ) : null}
                            <RenameNumberDialog
                              number={{
                                id: number.id,
                                phone_number: number.phone_number,
                                friendly_name: number.friendly_name || "",
                              }}
                            />
                            {number.released_at ? (
                              isAdmin ? (
                                <DeleteNumberDialog
                                  number={{
                                    id: number.id,
                                    phone_number: number.phone_number,
                                  }}
                                />
                              ) : null
                            ) : (
                              <>
                                {!number.elevenlabs_phone_number_id ? (
                                  <ConnectElevenLabsButton id={number.id} />
                                ) : null}
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
            </BulkMoveProvider>
          ) : (
            <div className="border-border flex flex-col items-center gap-2 rounded-2xl border border-dashed py-16 text-center">
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
        <div className="border-border flex flex-col items-center gap-2 rounded-2xl border border-dashed py-16 text-center">
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

/** Small pill for a number's POOL state, shown alongside the existing In pool /
 *  Released / EL ✓ badges (only rendered for non-released numbers — retirement,
 *  flagging, resting, and warm-up are all pool concepts). Checked in priority
 *  order: retired (terminal-ish, until reactivated) > flagged (operator called it
 *  out) > rested (health engine cooled it down, auto-returns) > warming (still
 *  ramping to its mature cap) > active (the steady state).
 *
 *  "Warming" is skipped when this number has no daily cap: warm-up only exists
 *  to ramp toward a ceiling, so with capping off there is nothing to ramp and
 *  the badge would promise a throttle that isn't running. */
function poolStateBadge(
  number: {
    pool_status: string;
    flagged_for_rotation: boolean;
    rested_until: string | null;
    warmup_started_at: string | null;
    daily_cap_override: number | null;
  },
  settings: PoolSettings,
  now: Date,
): React.ReactNode {
  if (number.pool_status === "retired") {
    return <Badge variant="ghost">Retired</Badge>;
  }
  if (number.flagged_for_rotation) {
    return <Badge variant="warning">Flagged</Badge>;
  }
  if (number.rested_until && new Date(number.rested_until) > now) {
    const hoursLeft = Math.max(
      1,
      Math.ceil(
        (new Date(number.rested_until).getTime() - now.getTime()) / 3_600_000,
      ),
    );
    return <Badge variant="secondary">Rested {hoursLeft}h</Badge>;
  }
  const capped =
    effectiveDailyCap({
      matureCap: number.daily_cap_override ?? settings.daily_cap,
      warmupStartCap: settings.warmup_start_cap,
      warmupDays: settings.warmup_days,
      warmupStartedAt: number.warmup_started_at,
      now: now.getTime(),
    }) !== UNCAPPED;
  if (capped && number.warmup_started_at) {
    const ageDays =
      (now.getTime() - new Date(number.warmup_started_at).getTime()) /
      86_400_000;
    if (ageDays < settings.warmup_days) {
      const dayN = Math.min(
        settings.warmup_days,
        Math.max(1, Math.floor(ageDays) + 1),
      );
      return (
        <Badge variant="secondary">
          Warming {dayN}/{settings.warmup_days}
        </Badge>
      );
    }
  }
  return (
    <Badge variant="success" dot>
      Active
    </Badge>
  );
}

/** Small visual indicator for the Webhooks column. The states that matter to the
 *  operator:
 *    · "Pointed at ElevenLabs" — both URLs match EL's native inbound endpoints.
 *                          Green check, no action needed.
 *    · "Pointed elsewhere" — Twilio has SOME URL on file, but it's not EL
 *                          (e.g. pointed back at the app, which breaks inbound).
 *                          Amber. The "Point to ElevenLabs" button fixes it.
 *    · "Not set"        — Twilio has nothing configured (or the
 *                          sync hasn't run yet). Muted dash.
 *    · "Released"       — short-circuit muted dash; the column is
 *                          irrelevant for released numbers. */
function WebhookStatus({
  voice,
  status,
  expected,
  released,
}: {
  voice: string | null;
  status: string | null;
  expected: { voiceUrl: string; statusCallback: string };
  released: boolean;
}) {
  if (released) {
    return <span className="text-muted-foreground text-xs">—</span>;
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
        Pointed at ElevenLabs
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
