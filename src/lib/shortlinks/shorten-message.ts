import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createShortLink } from "@/lib/shortlinks/client";
import {
  findFirstUrl,
  shortLinkLabel,
  withLeadParams,
  type LeadLinkParams,
} from "@/lib/shortlinks/destination";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/**
 * Personalise and shorten the link in a rendered message, for the send_text and
 * send_email tools.
 *
 * The template author pastes a plain link; we attach this lead's details and
 * swap in a short URL. The message body is returned ready to send.
 *
 * Ordering matters: we always substitute the full personalised destination
 * FIRST, then replace it with the short URL only if shortening succeeded. So a
 * slow or broken shortener costs extra SMS segments, never personalisation and
 * never the send itself.
 */
export async function shortenMessageLink(args: {
  supabase: SupabaseAdmin;
  leadId: string;
  ownerId: string;
  campaignId: string;
  channel: "sms" | "email";
  campaignName: string | null;
  company: string | null;
  body: string;
  params: LeadLinkParams;
}): Promise<string> {
  const templateUrl = findFirstUrl(args.body);
  if (!templateUrl) return args.body;

  const destination = withLeadParams(templateUrl, args.params);
  const shortUrl = await resolveShortUrl({ ...args, destination });
  const replacement = shortUrl ?? destination;
  // Function replacer: a literal one would treat `$&`/`$1` inside the URL as
  // substitution patterns and corrupt the link.
  return args.body.replace(templateUrl, () => replacement);
}

/** Reuse this lead's existing short URL for the same campaign + channel when the
 *  destination is unchanged, so repeat sends don't mint a new code every time
 *  and split the click count. An edited template changes the destination, which
 *  correctly mints a fresh one. */
async function resolveShortUrl(args: {
  supabase: SupabaseAdmin;
  leadId: string;
  ownerId: string;
  campaignId: string;
  channel: "sms" | "email";
  campaignName: string | null;
  company: string | null;
  destination: string;
}): Promise<string | null> {
  const existing = await args.supabase
    .from("short_links")
    .select("short_url, long_url")
    .eq("lead_id", args.leadId)
    .eq("channel", args.channel)
    .eq("campaign_id", args.campaignId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.data?.long_url === args.destination) {
    return existing.data.short_url;
  }

  const link = await createShortLink(
    args.destination,
    shortLinkLabel({
      campaignName: args.campaignName,
      company: args.company,
      channel: args.channel,
    }),
  );
  if (!link) return null;

  // Best-effort record: a failed insert costs us reuse next time, never the
  // send that's already in flight.
  const { error } = await args.supabase.from("short_links").insert({
    lead_id: args.leadId,
    owner_id: args.ownerId,
    campaign_id: args.campaignId,
    channel: args.channel,
    code: link.code,
    short_url: link.shortUrl,
    long_url: args.destination,
  });
  if (error) {
    console.error(`[shortlinks] could not record short link: ${error.message}`);
  }
  return link.shortUrl;
}
