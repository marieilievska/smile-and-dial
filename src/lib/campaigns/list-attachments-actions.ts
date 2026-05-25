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

  // Detach the ones no longer wanted.
  const toDetach = (currentAttachments ?? []).filter(
    (row) => !nextListIds.has(row.list_id),
  );
  if (toDetach.length > 0) {
    const { error } = await supabase
      .from("list_campaign_attachments")
      .update({ detached_at: new Date().toISOString() })
      .in(
        "id",
        toDetach.map((row) => row.id),
      );
    if (error) return { error: "Could not detach those lists." };
  }

  // Attach the new ones.
  const toAttach = [...nextListIds].filter((id) => !currentListIds.has(id));
  if (toAttach.length > 0) {
    const { error } = await supabase.from("list_campaign_attachments").insert(
      toAttach.map((listId) => ({
        list_id: listId,
        campaign_id: input.campaignId,
      })),
    );
    if (error) {
      // Most likely cause: list already attached to another active campaign.
      return {
        error:
          "One of those lists is already attached to another active campaign.",
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
    return {
      error:
        "Could not attach the list. It may already be attached to another active campaign.",
    };
  }

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(LISTS_PATH);
  return { error: null };
}

/** Detach a list from whichever campaign currently has it. */
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

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(LISTS_PATH);
  return { error: null };
}
