"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type KbResult = { error: string | null };

const BUCKET = "knowledge-base-files";
const KB_PATH = "/settings/knowledge-bases";

/** Create a knowledge base owned by the current user. */
export async function createKnowledgeBase(
  name: string,
  description: string,
): Promise<KbResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("knowledge_bases").insert({
    owner_id: user.id,
    name: trimmedName,
    description: description.trim() || null,
  });
  if (error) return { error: "Could not create the knowledge base." };

  revalidatePath(KB_PATH);
  return { error: null };
}

/** Rename or re-describe a knowledge base. */
export async function updateKnowledgeBase(
  id: string,
  name: string,
  description: string,
): Promise<KbResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("knowledge_bases")
    .update({ name: trimmedName, description: description.trim() || null })
    .eq("id", id);
  if (error) return { error: "Could not update the knowledge base." };

  revalidatePath(KB_PATH);
  return { error: null };
}

/** Delete a knowledge base, along with any files it has in storage. */
export async function deleteKnowledgeBase(id: string): Promise<KbResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: files } = await supabase
    .from("knowledge_base_sources")
    .select("file_path")
    .eq("kb_id", id)
    .eq("type", "file");
  const paths = (files ?? [])
    .map((f) => f.file_path)
    .filter((p): p is string => Boolean(p));
  if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths);

  const { error } = await supabase
    .from("knowledge_bases")
    .delete()
    .eq("id", id);
  if (error) return { error: "Could not delete the knowledge base." };

  revalidatePath(KB_PATH);
  return { error: null };
}

/** Add a URL source to a knowledge base. */
export async function addUrlSource(
  kbId: string,
  url: string,
): Promise<KbResult> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "Enter a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Enter an http or https URL." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("knowledge_base_sources")
    .insert({ kb_id: kbId, type: "url", url: trimmed });
  if (error) return { error: "Could not add the URL." };

  revalidatePath(KB_PATH);
  return { error: null };
}

/**
 * Record a file source. The file itself is uploaded to storage by the
 * browser before this runs; `filePath` is its storage path.
 */
export async function addFileSource(
  kbId: string,
  filePath: string,
): Promise<KbResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("knowledge_base_sources")
    .insert({ kb_id: kbId, type: "file", file_path: filePath });
  if (error) return { error: "Could not add the file." };

  revalidatePath(KB_PATH);
  return { error: null };
}

/** Remove a source, deleting its storage file when it is a file source. */
export async function removeSource(sourceId: string): Promise<KbResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: source } = await supabase
    .from("knowledge_base_sources")
    .select("type, file_path")
    .eq("id", sourceId)
    .maybeSingle();
  if (source?.type === "file" && source.file_path) {
    await supabase.storage.from(BUCKET).remove([source.file_path]);
  }

  const { error } = await supabase
    .from("knowledge_base_sources")
    .delete()
    .eq("id", sourceId);
  if (error) return { error: "Could not remove the source." };

  revalidatePath(KB_PATH);
  return { error: null };
}
