"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type AttachmentResult = { error: string | null };

const CAMPAIGNS_PATH = "/campaigns";
const LISTS_PATH = "/settings/lists";

/**
 * Sync the set of lists attached to a campaign. Detaches lists no longer
 * in the new set, attaches new ones. Called from the campaign settings
 * dialog's Lists tab after a successful save.
 */
export async function setCampaignLists(input: {
  campaignId: string;
  listIds: string[];
}): Promise<AttachmentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: currentAttachments } = await supabase
    .from("list_campaign_attachments")
    .select("id, list_id")
    .eq("campaign_id", input.campaignId)
    .is("detached_at", null);

  const currentListIds = new Set(
    (currentAttachments ?? []).map((row) => row.list_id),
  );
  const nextListIds = new Set(input.listIds);

  // Attach the new ones FIRST. The insert is the only operation that can
  // fail on a real constraint (the partial-unique index that stops a list
  // being actively attached to two campaigns). Doing it before the detach
  // means a constraint failure leaves the prior state fully intact rather
  // than detaching the removed lists and then failing to attach the new
  // ones — which would silently leave the campaign with the wrong set.
  const toAttach = [...nextListIds].filter((id) => !currentListIds.has(id));
  if (toAttach.length > 0) {
    const { error } = await supabase.from("list_campaign_attachments").insert(
      toAttach.map((listId) => ({
        list_id: listId,
        campaign_id: input.campaignId,
      })),
    );
    if (error) {
      // Nothing has been detached yet, so the campaign's list set is unchanged
      // and the user can retry. (Sharing a list across campaigns is allowed;
      // this only fires on a genuine insert failure.)
      return { error: "Could not attach those lists. Please try again." };
    }
  }

  // Detach the ones no longer wanted. Detach can't hit a unique index, so by
  // this point the operation is safe to complete.
  const toDetach = (currentAttachments ?? []).filter(
    (row) => !nextListIds.has(row.list_id),
  );
  if (toDetach.length > 0) {
    const detachIds = toDetach.map((row) => row.id);
    const { error } = await supabase
      .from("list_campaign_attachments")
      .update({ detached_at: new Date().toISOString() })
      .in("id", detachIds);
    if (error) return { error: "Could not detach those lists." };

    // Release this campaign's ownership of the detached lists' still-dialable
    // leads back to the shared pool so other sharing campaigns can finish them.
    // Terminal leads keep their owner for history. Detach ran FIRST on purpose:
    // once detached the campaign no longer matches these leads, so no tick can
    // re-claim them mid-release. We DO check this error — a silent failure here
    // would strand the leads under a campaign that no longer targets them; on
    // failure the admin retries (detach is a harmless no-op the second time and
    // the release then completes).
    const detachedListIds = toDetach.map((row) => row.list_id);
    const { error: releaseError } = await supabase
      .from("leads")
      .update({ owner_campaign_id: null })
      .eq("owner_campaign_id", input.campaignId)
      .in("list_id", detachedListIds)
      .in("status", ["ready_to_call", "callback", "resting"]);
    if (releaseError) {
      // Roll the detach back so the whole operation is all-or-nothing. Without
      // this, a committed detach drops these lists out of the active set, so a
      // retry recomputes an empty toDetach and never re-runs the release — the
      // leads stay stranded under a campaign that no longer targets them. Undo
      // is safe: nothing was released, so re-attaching can't strand anything,
      // and the next Save recomputes toDetach with these lists present and
      // re-drives both the detach and the release.
      await supabase
        .from("list_campaign_attachments")
        .update({ detached_at: null })
        .in("id", detachIds);
      return {
        error:
          "Couldn't update those lists — nothing was changed. Please retry.",
      };
    }
  }

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(LISTS_PATH);
  return { error: null };
}

/** Attach one list to a campaign. Used from the Lists row's attach button. */
export async function attachListToCampaign(input: {
  listId: string;
  campaignId: string;
}): Promise<AttachmentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("list_campaign_attachments").insert({
    list_id: input.listId,
    campaign_id: input.campaignId,
  });
  if (error) {
    return { error: "Could not attach the list. Please try again." };
  }

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(LISTS_PATH);
  return { error: null };
}

/** Detach a list from every campaign currently attached to it, releasing its leads. */
export async function detachList(listId: string): Promise<AttachmentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("list_campaign_attachments")
    .update({ detached_at: new Date().toISOString() })
    .eq("list_id", listId)
    .is("detached_at", null);
  if (error) return { error: "Could not detach the list." };

  // Release ownership of this list's still-dialable leads back to the pool.
  // Detach ran first (race-safe, see setCampaignLists); error-checked so a
  // failed release surfaces for retry instead of silently stranding leads.
  const { error: releaseError } = await supabase
    .from("leads")
    .update({ owner_campaign_id: null })
    .eq("list_id", listId)
    .in("status", ["ready_to_call", "callback", "resting"])
    .not("owner_campaign_id", "is", null);
  if (releaseError) {
    return { error: "Detached, but couldn't release its leads. Please retry." };
  }

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(LISTS_PATH);
  return { error: null };
}
