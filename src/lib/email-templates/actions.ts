"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type EmailTemplateActionResult = { error: string | null };

const SETTINGS_PATH = "/settings/email-templates";

/** Create an email template owned by the current user. The send_email tool
 *  sends the campaign's chosen template verbatim, filling {{variables}} from
 *  the lead. */
export async function createEmailTemplate(
  name: string,
  subject: string,
  body: string,
): Promise<EmailTemplateActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a template name." };
  if (!subject.trim()) return { error: "Enter a subject line." };
  if (!body.trim()) return { error: "Enter the email body." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("email_templates").insert({
    owner_id: user.id,
    name: trimmedName,
    subject: subject.trim(),
    body,
  });
  if (error) return { error: "Could not create the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}

/** Rename / re-edit a template. RLS limits this to the owner (or an admin). */
export async function updateEmailTemplate(
  id: string,
  name: string,
  subject: string,
  body: string,
): Promise<EmailTemplateActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a template name." };
  if (!subject.trim()) return { error: "Enter a subject line." };
  if (!body.trim()) return { error: "Enter the email body." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("email_templates")
    .update({
      name: trimmedName,
      subject: subject.trim(),
      body,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { error: "Could not update the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}

/** Delete a template. First clear it off any campaigns referencing it (the
 *  column has no FK), so those campaigns show "None" and the send_email tool
 *  just records intent until a new template is chosen. */
export async function deleteEmailTemplate(
  id: string,
): Promise<EmailTemplateActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // Detach from campaigns first so none point at a deleted template.
  await supabase
    .from("campaigns")
    .update({ email_template_id: null })
    .eq("email_template_id", id);

  const { error } = await supabase
    .from("email_templates")
    .delete()
    .eq("id", id);
  if (error) return { error: "Could not delete the template." };

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/campaigns");
  return { error: null };
}
