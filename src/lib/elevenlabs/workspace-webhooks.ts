import "server-only";

import type { WorkspaceWebhook } from "@/lib/alerts/webhook-health";

/**
 * The workspace's registered webhooks, with their delivery-health fields.
 * Read-only. Returns null on any failure (no key, non-2xx, bad JSON) — the
 * caller records "couldn't check" rather than guessing.
 */
export async function fetchWorkspaceWebhooks(): Promise<
  WorkspaceWebhook[] | null
> {
  const key = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
  if (!key) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/workspace/webhooks", {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    const list = Array.isArray(j)
      ? j
      : ((j as { webhooks?: unknown } | null)?.webhooks ?? null);
    if (!Array.isArray(list)) return null;
    return list.filter(
      (w): w is WorkspaceWebhook => typeof w === "object" && w !== null,
    );
  } catch {
    return null;
  }
}
