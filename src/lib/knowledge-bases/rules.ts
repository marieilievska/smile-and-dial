/**
 * Pure rules shared by the knowledge-base UI (client) and its server actions:
 * which files may be uploaded, how a source is named, and what its ElevenLabs
 * sync state is. No imports, so this is safe in "use client" components and
 * in unit tests.
 */

/** Extensions ElevenLabs can ingest and that we let through. Lower-case,
 *  with the leading dot. */
export const KNOWLEDGE_FILE_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".md",
  ".docx",
  ".html",
  ".htm",
] as const;

/** Hard cap on a single knowledge file: 10 MB. */
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** The `accept` attribute for the upload input. */
export const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_FILE_EXTENSIONS.join(",");

const ACCEPTED_LABEL = "PDF, TXT, MD, DOCX or HTML";

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function hasAcceptedExtension(name: string): boolean {
  const ext = extensionOf(name);
  return (KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Validate a file the browser is about to upload. Returns a user-facing
 * error, or null when the file is acceptable. Checks the extension (MIME
 * types are unreliable for .md/.docx) and the size cap.
 */
export function validateKnowledgeFile(file: {
  name: string;
  size: number;
}): string | null {
  if (!hasAcceptedExtension(file.name)) {
    return `That file type isn't supported. Upload a ${ACCEPTED_LABEL} file.`;
  }
  if (file.size > KNOWLEDGE_FILE_MAX_BYTES) {
    return "That file is too big. The limit is 10 MB.";
  }
  return null;
}

/**
 * Server-side check on the storage path the browser reports after an
 * upload: it must live under this knowledge base's folder
 * (`<kbId>/<uuid>/<filename>`), contain no traversal, and carry an accepted
 * extension. The storage RLS policy already scopes writes to the KB owner by
 * that first segment, so this mainly stops one KB's row pointing at another
 * KB's file.
 */
export function isKnowledgeFilePath(kbId: string, filePath: string): boolean {
  if (!kbId || !filePath) return false;
  if (!filePath.startsWith(`${kbId}/`)) return false;
  const segments = filePath.split("/");
  if (segments.length < 3) return false;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return hasAcceptedExtension(filePath);
}

export type KnowledgeSourceLike = {
  type: string;
  file_path: string | null;
  url: string | null;
};

/** Display name for a source: the URL, or the uploaded file's name. */
export function knowledgeSourceName(source: KnowledgeSourceLike): string {
  if (source.type === "url") return source.url ?? "";
  return source.file_path?.split("/").pop() ?? "File";
}

export type KnowledgeSyncState = "synced" | "error" | "pending";

/**
 * The truthful sync state of a source. A document id means ElevenLabs holds
 * the document (synced). Otherwise a recorded error means the last attempt
 * failed; and no id + no error means it has never been tried (pending —
 * e.g. rows created before sync existed).
 */
export function sourceSyncState(source: {
  elevenlabs_document_id: string | null;
  sync_error: string | null;
}): KnowledgeSyncState {
  if (source.elevenlabs_document_id) return "synced";
  if (source.sync_error) return "error";
  return "pending";
}
