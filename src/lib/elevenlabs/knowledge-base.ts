/**
 * ElevenLabs knowledge-base documents.
 *
 * ElevenLabs has no "knowledge base" container: every file or URL is its own
 * DOCUMENT, and an agent lists the documents it may draw on in
 * `conversation_config.agent.prompt.knowledge_base[]`. So our app-level
 * knowledge base (a named group of sources) maps to N documents, one per
 * source, tracked in `knowledge_base_sources.elevenlabs_document_id`.
 *
 * Endpoints (https://elevenlabs.io/docs/api-reference/knowledge-base):
 *   POST   /v1/convai/knowledge-base/url    { url, name? }        → { id, name }
 *   POST   /v1/convai/knowledge-base/file   multipart file, name? → { id, name }
 *   GET    /v1/convai/knowledge-base/{id}                          → document
 *   DELETE /v1/convai/knowledge-base/{id}?force=true
 *          force detaches the document from every dependent agent first —
 *          without it the API refuses to delete a document an agent uses.
 *
 * Everything that touches the network is mocked unless ELEVENLABS_LIVE=live,
 * following agents.ts / server-tools.ts, so tests and local dev stay free.
 */

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { knowledgeSourceName } from "@/lib/knowledge-bases/rules";
import type { Database } from "@/lib/supabase/database.types";

const KB_API = "https://api.elevenlabs.io/v1/convai/knowledge-base";

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

function fetchApiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export type KnowledgeDocumentResult = {
  documentId: string | null;
  error: string | null;
};

/** Pull a short, human-readable reason out of a failed response. */
async function failureReason(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const text = (await res.text()).trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        const d = parsed.detail;
        if (typeof d === "string") detail = d;
        else if (d && typeof d === "object" && "message" in d) {
          detail = String((d as { message: unknown }).message);
        } else detail = text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // no body
  }
  const short = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return `${what} failed (${res.status})${short ? `: ${short}` : "."}`;
}

/** Create a document by letting ElevenLabs scrape a web page. */
export async function createKnowledgeDocumentFromUrl(
  url: string,
  name: string,
): Promise<KnowledgeDocumentResult> {
  if (!isLive()) {
    return { documentId: `kbdoc_mock_${crypto.randomUUID()}`, error: null };
  }
  const apiKey = fetchApiKey();
  if (!apiKey)
    return { documentId: null, error: "ElevenLabs API key isn't set." };

  try {
    const res = await fetch(`${KB_API}/url`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ url, name }),
    });
    if (!res.ok) {
      return {
        documentId: null,
        error: await failureReason(res, "ElevenLabs URL upload"),
      };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      return { documentId: null, error: "ElevenLabs returned no document id." };
    }
    return { documentId: data.id, error: null };
  } catch {
    return { documentId: null, error: "ElevenLabs URL upload failed." };
  }
}

/** Create a document from file bytes (multipart/form-data). */
export async function createKnowledgeDocumentFromFile(
  file: { blob: Blob; filename: string },
  name: string,
): Promise<KnowledgeDocumentResult> {
  if (!isLive()) {
    return { documentId: `kbdoc_mock_${crypto.randomUUID()}`, error: null };
  }
  const apiKey = fetchApiKey();
  if (!apiKey)
    return { documentId: null, error: "ElevenLabs API key isn't set." };

  const form = new FormData();
  form.append("file", file.blob, file.filename);
  form.append("name", name);

  try {
    // No Content-Type header: fetch sets multipart/form-data with the
    // boundary itself when the body is a FormData.
    const res = await fetch(`${KB_API}/file`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    if (!res.ok) {
      return {
        documentId: null,
        error: await failureReason(res, "ElevenLabs file upload"),
      };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      return { documentId: null, error: "ElevenLabs returned no document id." };
    }
    return { documentId: data.id, error: null };
  } catch {
    return { documentId: null, error: "ElevenLabs file upload failed." };
  }
}

export type KnowledgeDocumentStatus =
  | { state: "present"; sizeBytes: number | null }
  | { state: "missing" }
  | { state: "unknown"; error: string };

/**
 * Does ElevenLabs still hold this document? The document GET exposes size
 * and supported usages but no per-document indexing state (RAG indexes are a
 * separate resource and are computed automatically once a RAG-enabled agent
 * references the document), so "present" is the strongest status we can
 * report. Used by the retry path to re-upload documents that vanished.
 */
export async function getKnowledgeDocumentStatus(
  documentId: string,
): Promise<KnowledgeDocumentStatus> {
  if (!isLive()) return { state: "present", sizeBytes: null };
  const apiKey = fetchApiKey();
  if (!apiKey)
    return { state: "unknown", error: "ElevenLabs API key isn't set." };
  try {
    const res = await fetch(`${KB_API}/${encodeURIComponent(documentId)}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (res.status === 404) return { state: "missing" };
    if (!res.ok) {
      return {
        state: "unknown",
        error: await failureReason(res, "ElevenLabs document lookup"),
      };
    }
    const data = (await res.json()) as {
      metadata?: { size_bytes?: number };
    };
    const size = data.metadata?.size_bytes;
    return {
      state: "present",
      sizeBytes: typeof size === "number" ? size : null,
    };
  } catch {
    return { state: "unknown", error: "ElevenLabs document lookup failed." };
  }
}

/**
 * Delete a document. `force=true` so a document still attached to an agent
 * is detached from it and deleted in one call (the API otherwise refuses).
 * A 404 counts as success — the document is gone either way.
 */
export async function deleteKnowledgeDocument(
  documentId: string,
): Promise<{ error: string | null }> {
  if (!isLive()) return { error: null };
  const apiKey = fetchApiKey();
  if (!apiKey) return { error: "ElevenLabs API key isn't set." };
  try {
    const res = await fetch(
      `${KB_API}/${encodeURIComponent(documentId)}?force=true`,
      { method: "DELETE", headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok && res.status !== 404) {
      return { error: await failureReason(res, "ElevenLabs document delete") };
    }
    return { error: null };
  } catch {
    return { error: "ElevenLabs document delete failed." };
  }
}

// ---------------------------------------------------------------------------
// Agent payload: which documents an agent may draw on.
// ---------------------------------------------------------------------------

/** One entry of `conversation_config.agent.prompt.knowledge_base`. */
export type KnowledgeBaseLocator = {
  type: "file" | "url";
  id: string;
  name: string;
  /** `auto` — retrieved via RAG when the agent has RAG enabled (we enable it
   *  whenever documents are attached), otherwise placed in the prompt. */
  usage_mode: "auto";
};

export type SyncedSourceRow = {
  type: string;
  file_path: string | null;
  url: string | null;
  elevenlabs_document_id: string | null;
};

/**
 * Build the agent's `knowledge_base` list from its knowledge bases' sources.
 * Only sources that actually reached ElevenLabs (have a document id) are
 * included; duplicates (the same document reached via two KBs) collapse to
 * one entry. Pure.
 */
export function buildAgentKnowledgeBase(
  sources: SyncedSourceRow[],
): KnowledgeBaseLocator[] {
  const out: KnowledgeBaseLocator[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const id = s.elevenlabs_document_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      type: s.type === "url" ? "url" : "file",
      id,
      name: knowledgeSourceName(s),
      usage_mode: "auto",
    });
  }
  return out;
}

/**
 * Merge our documents into a connected (ElevenLabs-built) agent's existing
 * `knowledge_base` list. Entries the user attached in the ElevenLabs
 * dashboard are kept; entries pointing at documents WE manage are dropped
 * and replaced by `ours`, so our set fully controls which of our documents
 * are attached (mirrors the tool_ids merge in applyConnectedAgentIntegration).
 * Pure.
 */
export function mergeKnowledgeBase(
  existing: unknown,
  ours: KnowledgeBaseLocator[],
  managedDocumentIds: Set<string>,
): Array<KnowledgeBaseLocator | Record<string, unknown>> {
  const kept: Record<string, unknown>[] = [];
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && managedDocumentIds.has(id)) continue;
      kept.push(entry as Record<string, unknown>);
    }
  }
  return [...kept, ...ours];
}

// ---------------------------------------------------------------------------
// DB lookups (service role — the agent sync runs outside the user's RLS
// scope, and an admin's agent may reference a member's knowledge base).
// ---------------------------------------------------------------------------

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServiceClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Resolve an agent's `knowledge_base_ids` to the ElevenLabs documents it may
 * draw on: every SYNCED source of those knowledge bases, oldest first.
 * Returns [] when the agent has no knowledge bases or the lookup fails (the
 * agent then syncs with no documents rather than not at all).
 */
export async function resolveAgentKnowledgeBase(
  knowledgeBaseIds: string[] | undefined,
): Promise<KnowledgeBaseLocator[]> {
  const ids = (knowledgeBaseIds ?? []).filter(Boolean);
  if (ids.length === 0) return [];
  const sb = serviceClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("knowledge_base_sources")
      .select("type, file_path, url, elevenlabs_document_id, created_at")
      .in("kb_id", ids)
      .not("elevenlabs_document_id", "is", null)
      .order("created_at", { ascending: true });
    if (error || !data) return [];
    return buildAgentKnowledgeBase(data);
  } catch {
    return [];
  }
}

/**
 * Every ElevenLabs document id this app manages. Lets the connected-agent
 * overlay tell OUR entries apart from ones the user attached in the
 * ElevenLabs dashboard.
 */
export async function managedKnowledgeDocumentIds(): Promise<Set<string>> {
  const sb = serviceClient();
  if (!sb) return new Set();
  try {
    const { data } = await sb
      .from("knowledge_base_sources")
      .select("elevenlabs_document_id")
      .not("elevenlabs_document_id", "is", null);
    return new Set(
      (data ?? [])
        .map((r) => r.elevenlabs_document_id)
        .filter((id): id is string => Boolean(id)),
    );
  } catch {
    return new Set();
  }
}
