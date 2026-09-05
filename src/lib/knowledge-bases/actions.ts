"use server";

import { revalidatePath } from "next/cache";

import {
  createKnowledgeDocumentFromFile,
  createKnowledgeDocumentFromUrl,
  deleteKnowledgeDocument,
  getKnowledgeDocumentStatus,
} from "@/lib/elevenlabs/knowledge-base";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  agentsUsingKnowledgeBase,
  resyncAgentsUsingKnowledgeBase,
} from "./resync-agents";
import { isKnowledgeFilePath, knowledgeSourceName } from "./rules";

export type KbResult = {
  error: string | null;
  /** The row was saved but the ElevenLabs upload failed — the source shows
   *  as "Sync failed" with a retry. Surfaced as a warning, not an error. */
  warning?: string;
};

export type KbSyncResult = {
  error: string | null;
  synced?: number;
  failed?: number;
};

const BUCKET = "knowledge-base-files";
const KB_PATH = "/settings/knowledge-bases";

const SOURCE_COLUMNS =
  "id, kb_id, type, file_path, url, elevenlabs_document_id, sync_error";

type SourceRow = {
  id: string;
  kb_id: string;
  type: string;
  file_path: string | null;
  url: string | null;
  elevenlabs_document_id: string | null;
};

type UserClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Upload ONE source to ElevenLabs and record the outcome on its row: the
 * document id + synced_at on success, sync_error on failure (the row is kept
 * either way, so the user can retry). Files are read from the private bucket
 * with the service client. Never throws.
 */
async function syncSourceToElevenLabs(
  supabase: UserClient,
  source: SourceRow,
): Promise<{ error: string | null }> {
  const name = knowledgeSourceName(source);
  let result: { documentId: string | null; error: string | null };

  if (source.type === "url") {
    result = source.url
      ? await createKnowledgeDocumentFromUrl(source.url, name)
      : { documentId: null, error: "The source has no URL." };
  } else if (!source.file_path) {
    result = { documentId: null, error: "The source has no file." };
  } else {
    const { data: blob, error: downloadError } = await createAdminClient()
      .storage.from(BUCKET)
      .download(source.file_path);
    result =
      downloadError || !blob
        ? {
            documentId: null,
            error: "Could not read the file from storage.",
          }
        : await createKnowledgeDocumentFromFile({ blob, filename: name }, name);
  }

  if (result.error || !result.documentId) {
    const message = result.error ?? "ElevenLabs sync failed.";
    await supabase
      .from("knowledge_base_sources")
      .update({ sync_error: message })
      .eq("id", source.id);
    return { error: message };
  }

  await supabase
    .from("knowledge_base_sources")
    .update({
      elevenlabs_document_id: result.documentId,
      synced_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq("id", source.id);
  return { error: null };
}

/** Best-effort delete of a source's ElevenLabs document. `force` detaches it
 *  from any agent first; a 404 is fine. Failures are logged, never fatal —
 *  the app-side removal must not be blocked by ElevenLabs being down. */
async function deleteDocumentBestEffort(
  documentId: string | null,
  context: string,
): Promise<void> {
  if (!documentId) return;
  const r = await deleteKnowledgeDocument(documentId);
  if (r.error) {
    console.error(
      `[knowledge-bases] ${context}: could not delete ElevenLabs document ${documentId}: ${r.error}`,
    );
  }
}

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

/** Rename or re-describe a knowledge base. (ElevenLabs documents are named
 *  after their source — the file name or URL — so a rename here has nothing
 *  to push.) */
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

/**
 * Delete a knowledge base: its ElevenLabs documents (best-effort, first),
 * its files in storage, then the rows (sources cascade).
 *
 * BLOCKED while any agent still references it. We chose blocking over
 * silently detaching + re-syncing those agents: an agent's knowledge is part
 * of its behaviour on live calls, and the person deleting a knowledge base
 * (possibly a member) may not even be able to see the (admin's) agent that
 * uses it. The message names the agents so they can be edited first.
 */
export async function deleteKnowledgeBase(id: string): Promise<KbResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: kb } = await supabase
    .from("knowledge_bases")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!kb) return { error: "That knowledge base no longer exists." };

  const using = await agentsUsingKnowledgeBase(id);
  if (using.count > 0) {
    const list = using.names.slice(0, 3).join(", ");
    const more = using.count > 3 ? ` and ${using.count - 3} more` : "";
    return {
      error: `This knowledge base is attached to ${using.count} agent${
        using.count === 1 ? "" : "s"
      } (${list}${more}). Detach it from ${
        using.count === 1 ? "that agent" : "those agents"
      } first.`,
    };
  }

  const { data: sources } = await supabase
    .from("knowledge_base_sources")
    .select("type, file_path, elevenlabs_document_id")
    .eq("kb_id", id);

  for (const s of sources ?? []) {
    await deleteDocumentBestEffort(
      s.elevenlabs_document_id,
      "deleteKnowledgeBase",
    );
  }

  const paths = (sources ?? [])
    .filter((s) => s.type === "file")
    .map((s) => s.file_path)
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

/** After a knowledge base's sources changed, re-push every agent that uses
 *  it so the agent's ElevenLabs `knowledge_base` list matches. Best-effort. */
async function resyncAgents(kbId: string): Promise<void> {
  await resyncAgentsUsingKnowledgeBase(kbId);
}

/** Add a URL source and upload it to ElevenLabs right away. */
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

  const { data: source, error } = await supabase
    .from("knowledge_base_sources")
    .insert({ kb_id: kbId, type: "url", url: trimmed })
    .select(SOURCE_COLUMNS)
    .single();
  if (error || !source) return { error: "Could not add the URL." };

  const sync = await syncSourceToElevenLabs(supabase, source);
  await resyncAgents(kbId);

  revalidatePath(KB_PATH);
  return {
    error: null,
    ...(sync.error
      ? { warning: `Added, but not synced to ElevenLabs yet: ${sync.error}` }
      : {}),
  };
}

/**
 * Record a file source and upload it to ElevenLabs right away. The file
 * itself is uploaded to storage by the browser before this runs; `filePath`
 * is its storage path, which must sit under this knowledge base's folder and
 * carry an accepted extension (the browser checks the same rules first; this
 * is the server-side backstop).
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

  if (!isKnowledgeFilePath(kbId, filePath)) {
    // Don't leave a stray object behind (the RLS policy only lets the KB's
    // owner remove it anyway, so this is a no-op for a foreign path).
    await supabase.storage.from(BUCKET).remove([filePath]);
    return {
      error:
        "That file isn't allowed. Upload a PDF, TXT, MD, DOCX or HTML file.",
    };
  }

  const { data: source, error } = await supabase
    .from("knowledge_base_sources")
    .insert({ kb_id: kbId, type: "file", file_path: filePath })
    .select(SOURCE_COLUMNS)
    .single();
  if (error || !source) return { error: "Could not add the file." };

  const sync = await syncSourceToElevenLabs(supabase, source);
  await resyncAgents(kbId);

  revalidatePath(KB_PATH);
  return {
    error: null,
    ...(sync.error
      ? { warning: `Added, but not synced to ElevenLabs yet: ${sync.error}` }
      : {}),
  };
}

/** Remove a source: its ElevenLabs document first (best-effort), then its
 *  storage file, then the row; then re-push the agents using its KB. */
export async function removeSource(sourceId: string): Promise<KbResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: source } = await supabase
    .from("knowledge_base_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", sourceId)
    .maybeSingle();
  if (!source) return { error: "That source no longer exists." };

  await deleteDocumentBestEffort(source.elevenlabs_document_id, "removeSource");
  if (source.type === "file" && source.file_path) {
    await supabase.storage.from(BUCKET).remove([source.file_path]);
  }

  const { error } = await supabase
    .from("knowledge_base_sources")
    .delete()
    .eq("id", sourceId);
  if (error) return { error: "Could not remove the source." };

  await resyncAgents(source.kb_id);

  revalidatePath(KB_PATH);
  return { error: null };
}

/**
 * Retry the ElevenLabs upload for every source of a knowledge base that
 * isn't synced — and re-upload any "synced" source whose document has since
 * vanished on the ElevenLabs side — then re-push the agents using it. Backs
 * the Sync button in the sources dialog; also the one-off step for sources
 * created before sync existed.
 */
export async function retryKnowledgeBaseSync(
  kbId: string,
): Promise<KbSyncResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: sources, error } = await supabase
    .from("knowledge_base_sources")
    .select(SOURCE_COLUMNS)
    .eq("kb_id", kbId)
    .order("created_at", { ascending: true });
  if (error) return { error: "Could not load the sources." };

  let synced = 0;
  let failed = 0;
  for (const source of sources ?? []) {
    let toSync: SourceRow = source;
    if (source.elevenlabs_document_id) {
      const status = await getKnowledgeDocumentStatus(
        source.elevenlabs_document_id,
      );
      if (status.state === "present") {
        synced += 1;
        continue;
      }
      if (status.state === "unknown") {
        // Can't tell — leave the row alone rather than re-upload blindly.
        failed += 1;
        continue;
      }
      // Gone on ElevenLabs: forget the stale id and upload again.
      await supabase
        .from("knowledge_base_sources")
        .update({ elevenlabs_document_id: null, synced_at: null })
        .eq("id", source.id);
      toSync = { ...source, elevenlabs_document_id: null };
    }
    const r = await syncSourceToElevenLabs(supabase, toSync);
    if (r.error) failed += 1;
    else synced += 1;
  }

  await resyncAgents(kbId);

  revalidatePath(KB_PATH);
  return { error: null, synced, failed };
}
