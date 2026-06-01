import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@supabase/supabase-js";

import { constantTimeEqual, hashApiKey } from "@/lib/api-keys/generator";

/** POST /api/v1/leads — Public lead-creation endpoint (Step 41 / §14).
 *
 *  Auth: Bearer <sk_…> via Authorization header.
 *  Optional: Idempotency-Key header for safe retries.
 *
 *  Per spec: Twilio Lookup is NOT run on API-created leads (external
 *  systems have already collected consent). Dedup matches by phone within
 *  the API key owner's leads; on match we return 200 with the existing
 *  row, otherwise 201 with the new one.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return NextResponse.json({ error: "config_missing" }, { status: 500 });
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- Auth ---
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer (sk_[A-Za-z0-9_-]+)$/.exec(auth);
  if (!match) {
    return NextResponse.json(
      { error: "missing_or_malformed_key" },
      { status: 401 },
    );
  }
  const hashed = hashApiKey(match[1]);
  if (!hashed) {
    return NextResponse.json({ error: "malformed_key" }, { status: 401 });
  }
  const { data: keyRow } = await supabase
    .from("api_keys")
    .select("id, owner_id, key_hash, revoked_at")
    .eq("key_prefix", hashed.keyPrefix)
    .maybeSingle();
  if (!keyRow || keyRow.revoked_at) {
    return NextResponse.json(
      { error: "invalid_or_revoked_key" },
      { status: 403 },
    );
  }
  if (!constantTimeEqual(keyRow.key_hash, hashed.keyHash)) {
    return NextResponse.json(
      { error: "invalid_or_revoked_key" },
      { status: 403 },
    );
  }

  // --- Rate limit: fixed window per key, enforced before any writes so a
  //     runaway loop can't exhaust the DB or amplify downstream call cost.
  //     120 requests / 60s is generous for legit partner integrations. A
  //     failure to record the hit must NOT block legit traffic, so we only
  //     reject when the RPC succeeds and reports over the limit. ---
  const RATE_LIMIT = 120;
  const RATE_WINDOW_SECONDS = 60;
  const { data: rlCount, error: rlError } = await supabase.rpc(
    "bump_api_rate_limit",
    { in_api_key_id: keyRow.id, in_window_seconds: RATE_WINDOW_SECONDS },
  );
  if (!rlError && typeof rlCount === "number" && rlCount > RATE_LIMIT) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(RATE_WINDOW_SECONDS) },
      },
    );
  }

  // --- Idempotency: replay the cached response if we've seen this key. ---
  const idemKey = request.headers.get("idempotency-key");
  if (idemKey) {
    const { data: cached } = await supabase
      .from("api_idempotency_keys")
      .select("response")
      .eq("api_key_id", keyRow.id)
      .eq("idempotency_key", idemKey)
      .maybeSingle();
    if (cached?.response) {
      const cachedResp = cached.response as {
        status: number;
        body: Record<string, unknown>;
      };
      return NextResponse.json(cachedResp.body, { status: cachedResp.status });
    }
  }

  // --- Body ---
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const phone =
    typeof body.business_phone === "string" ? body.business_phone : "";
  if (!phone) {
    return NextResponse.json(
      { error: "business_phone is required" },
      { status: 400 },
    );
  }

  // --- Dedup by phone within this owner's leads. ---
  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("owner_id", keyRow.owner_id)
    .eq("business_phone", phone)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing) {
    const body200 = { id: existing.id, status: "duplicate" };
    if (idemKey) {
      await supabase.from("api_idempotency_keys").insert({
        api_key_id: keyRow.id,
        idempotency_key: idemKey,
        lead_id: existing.id,
        response: { status: 200, body: body200 },
      });
    }
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", keyRow.id);
    return NextResponse.json(body200, { status: 200 });
  }

  // --- Resolve list. If `list` is provided, look it up by name under this
  //     owner; otherwise create / use a default "API Inbound" list. ---
  let listId: string | null = null;
  const listName =
    typeof body.list === "string" && body.list.trim()
      ? body.list.trim()
      : "API Inbound";
  const { data: listRow } = await supabase
    .from("lists")
    .select("id")
    .eq("owner_id", keyRow.owner_id)
    .eq("name", listName)
    .maybeSingle();
  if (listRow) {
    listId = listRow.id;
  } else {
    const { data: newList, error: listErr } = await supabase
      .from("lists")
      .insert({ owner_id: keyRow.owner_id, name: listName })
      .select("id")
      .single();
    if (listErr || !newList) {
      return NextResponse.json(
        { error: "list_create_failed" },
        { status: 500 },
      );
    }
    listId = newList.id;
  }

  // --- Insert the lead. ---
  const insertPayload: Record<string, unknown> = {
    owner_id: keyRow.owner_id,
    list_id: listId,
    business_phone: phone,
    status: "ready_to_call",
    timezone: "America/New_York",
  };
  if (typeof body.company === "string") insertPayload.company = body.company;
  if (typeof body.business_email === "string")
    insertPayload.business_email = body.business_email;
  if (typeof body.city === "string") insertPayload.city = body.city;
  if (typeof body.state === "string") insertPayload.state = body.state;
  if (typeof body.owner_name === "string")
    insertPayload.owner_name = body.owner_name;
  if (typeof body.owner_phone === "string")
    insertPayload.owner_phone = body.owner_phone;

  const { data: lead, error: insertErr } = await supabase
    .from("leads")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertErr || !lead) {
    return NextResponse.json({ error: "lead_create_failed" }, { status: 500 });
  }

  // --- Custom fields: { slug: value } — insert into lead_custom_values. ---
  if (
    body.custom_fields &&
    typeof body.custom_fields === "object" &&
    !Array.isArray(body.custom_fields)
  ) {
    const cf = body.custom_fields as Record<string, unknown>;
    const slugs = Object.keys(cf);
    if (slugs.length > 0) {
      const { data: defs } = await supabase
        .from("custom_field_defs")
        .select("id, name")
        .in("name", slugs);
      const bySlug = new Map((defs ?? []).map((d) => [d.name, d.id] as const));
      const rows = slugs
        .map((slug) => {
          const id = bySlug.get(slug);
          if (!id) return null;
          return {
            lead_id: lead.id,
            custom_field_id: id,
            value: cf[slug],
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length > 0) {
        await supabase.from("lead_custom_values").insert(rows);
      }
    }
  }

  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id);

  const body201 = { id: lead.id, status: "created" };
  if (idemKey) {
    await supabase.from("api_idempotency_keys").insert({
      api_key_id: keyRow.id,
      idempotency_key: idemKey,
      lead_id: lead.id,
      response: { status: 201, body: body201 },
    });
  }
  return NextResponse.json(body201, { status: 201 });
}
