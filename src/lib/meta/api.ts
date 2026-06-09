import "server-only";

import { META_SCHEMA } from "./audience-fields";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Normalize "123" or "act_123" -> "act_123". */
function normalizeAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

export type MetaResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Create the customer-list Custom Audience and return its id. */
export async function createAudience(
  adAccountId: string,
  accessToken: string,
  name: string,
): Promise<MetaResult<{ id: string }>> {
  try {
    const res = await fetch(
      `${GRAPH}/${normalizeAccountId(adAccountId)}/customaudiences`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          subtype: "CUSTOM",
          customer_file_source: "USER_PROVIDED_ONLY",
          access_token: accessToken,
        }),
      },
    );
    const body = (await res.json()) as {
      id?: string;
      error?: { message?: string };
    };
    if (!res.ok || !body.id) {
      return {
        ok: false,
        error: body.error?.message ?? `status ${res.status}`,
      };
    }
    return { ok: true, data: { id: body.id } };
  } catch {
    return { ok: false, error: "Meta create-audience request failed." };
  }
}

/** Add or remove hashed rows on an audience. `op` picks the HTTP method. Rows
 *  are aligned to META_SCHEMA. Caller batches to <= 10,000 rows per call. */
async function mutateUsers(
  op: "add" | "remove",
  audienceId: string,
  accessToken: string,
  rows: string[][],
): Promise<MetaResult<{ count: number }>> {
  if (rows.length === 0) return { ok: true, data: { count: 0 } };
  try {
    const res = await fetch(`${GRAPH}/${audienceId}/users`, {
      method: op === "add" ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { schema: [...META_SCHEMA], data: rows },
        access_token: accessToken,
      }),
    });
    const body = (await res.json()) as {
      num_received?: number;
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        error: body.error?.message ?? `status ${res.status}`,
      };
    }
    return { ok: true, data: { count: body.num_received ?? rows.length } };
  } catch {
    return { ok: false, error: `Meta ${op}-users request failed.` };
  }
}

export const addUsers = (audienceId: string, token: string, rows: string[][]) =>
  mutateUsers("add", audienceId, token, rows);

export const removeUsers = (
  audienceId: string,
  token: string,
  rows: string[][],
) => mutateUsers("remove", audienceId, token, rows);

/** Max rows per Meta users request. */
export const META_BATCH = 10000;
