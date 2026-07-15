"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type SmsTemplateActionResult = { error: string | null };

const SETTINGS_PATH = "/settings/sms-templates";

/** Create an SMS template owned by the current user. The send_text tool sends
 *  the campaign's chosen template verbatim (+ an auto opt-out line), filling
 *  {{variables}} from the lead. */
export async function createSmsTemplate(
  name: string,
  body: string,
): Promise<SmsTemplateActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a template name." };
  if (!body.trim()) return { error: "Enter the message body." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("sms_templates").insert({
    owner_id: user.id,
    name: trimmedName,
    body,
  });
  if (error) return { error: "Could not create the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}

/** Rename / re-edit a template. RLS limits this to the owner (or an admin). */
export async function updateSmsTemplate(
  id: string,
  name: string,
  body: string,
): Promise<SmsTemplateActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a template name." };
  if (!body.trim()) return { error: "Enter the message body." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("sms_templates")
    .update({
      name: trimmedName,
      body,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { error: "Could not update the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}

/** Delete a template. First clear it off any campaigns referencing it so those
 *  campaigns show "None" and the send_text tool just records intent until a new
 *  template is chosen. */
export async function deleteSmsTemplate(
  id: string,
): Promise<SmsTemplateActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  await supabase
    .from("campaigns")
    .update({ sms_template_id: null })
    .eq("sms_template_id", id);

  const { error } = await supabase.from("sms_templates").delete().eq("id", id);
  if (error) return { error: "Could not delete the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}
