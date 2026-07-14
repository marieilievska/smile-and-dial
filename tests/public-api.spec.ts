import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "crypto";

/**
 * Public API (Step 41 / BUILD_PLAN §14).
 *
 * Coverage:
 *  - Invalid key → 403; missing key → 401
 *  - Valid key creates a lead (201) under the key owner's list
 *  - Same phone returns 200 with status=duplicate
 *  - Idempotency-Key replays the cached response on retry
 */
test.describe.configure({ mode: "serial" });

test.describe("Public API: POST /api/v1/leads", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let apiKeyId: string;
  let rawKey: string;
  const createdLeadIds: string[] = [];
  const idempotencyKey = `idem-${stamp}`;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    // Mint an API key the same way the server action does (so the
    // hash matches when the endpoint validates it).
    const random = randomBytes(24)
      .toString("base64url")
      .replace(/=+$/g, "")
      .slice(0, 32);
    rawKey = `sk_${random}`;
    const keyPrefix = random.slice(0, 8);
    const keyHash = createHash("sha256").update(random).digest("hex");
    const { data } = await admin
      .from("api_keys")
      .insert({
        owner_id: ownerId,
        name: `E2E Public API key ${stamp}`,
        key_prefix: keyPrefix,
        key_hash: keyHash,
      })
      .select("id")
      .single();
    apiKeyId = data!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("api_idempotency_keys")
      .delete()
      .eq("api_key_id", apiKeyId);
    if (createdLeadIds.length > 0) {
      await admin.from("leads").delete().in("id", createdLeadIds);
    }
    await admin
      .from("lists")
      .delete()
      .eq("owner_id", ownerId)
      .eq("name", "API Inbound");
    if (apiKeyId) {
      await admin.from("api_rate_limits").delete().eq("api_key_id", apiKeyId);
      await admin.from("api_keys").delete().eq("id", apiKeyId);
    }
  });

  test("missing key → 401", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const r = await api.post("/api/v1/leads", {
      data: { business_phone: `+1777${tail}1` },
    });
    expect(r.status()).toBe(401);
  });

  test("invalid key → 403", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const r = await api.post("/api/v1/leads", {
      headers: { authorization: `Bearer sk_${"x".repeat(20)}` },
      data: { business_phone: `+1777${tail}2` },
    });
    expect(r.status()).toBe(403);
  });

  test("valid key creates a lead (201)", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const phone = `+1777${tail}3`;
    const r = await api.post("/api/v1/leads", {
      headers: { authorization: `Bearer ${rawKey}` },
      data: {
        business_phone: phone,
        company: `E2E API Lead ${stamp}`,
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.status).toBe("created");
    createdLeadIds.push(body.id);

    const { data: lead } = await admin
      .from("leads")
      .select("id, owner_id, business_phone")
      .eq("id", body.id)
      .single();
    expect(lead?.owner_id).toBe(ownerId);
    expect(lead?.business_phone).toBe(phone);
  });

  test("same phone returns 200 duplicate", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const phone = `+1777${tail}3`;
    const r = await api.post("/api/v1/leads", {
      headers: { authorization: `Bearer ${rawKey}` },
      data: { business_phone: phone },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("duplicate");
  });

  test("Idempotency-Key replays the cached response", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const phone = `+1777${tail}4`;
    const headers = {
      authorization: `Bearer ${rawKey}`,
      "idempotency-key": idempotencyKey,
    };

    const first = await api.post("/api/v1/leads", {
      headers,
      data: { business_phone: phone },
    });
    expect(first.status()).toBe(201);
    const firstBody = await first.json();
    createdLeadIds.push(firstBody.id);

    // Replay with same Idempotency-Key + same body — server returns the
    // cached response, no new row.
    const second = await api.post("/api/v1/leads", {
      headers,
      data: { business_phone: phone },
    });
    expect(second.status()).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);

    const { data: rows } = await admin
      .from("leads")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("business_phone", phone);
    expect(rows?.length).toBe(1);
  });

  test("normalizes a non-E.164 phone to E.164 on create", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    // A bare 10-digit number (no +1) — the format partner CRMs commonly send.
    // It must be stored as E.164 (+1XXXXXXXXXX) so DNC suppression (an exact
    // string match) and the dialer both work; otherwise a suppressed number
    // sent in this shape would silently be dialed.
    const digits = `775${tail}0`; // 10 digits, distinct area from other tests
    const r = await api.post("/api/v1/leads", {
      headers: { authorization: `Bearer ${rawKey}` },
      data: { business_phone: digits, company: `E2E API Norm ${stamp}` },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdLeadIds.push(body.id);

    const { data: lead } = await admin
      .from("leads")
      .select("business_phone")
      .eq("id", body.id)
      .single();
    expect(lead?.business_phone).toBe(`+1${digits}`);
  });

  test("rejects a phone that isn't a valid US/CA number → 400", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const r = await api.post("/api/v1/leads", {
      headers: { authorization: `Bearer ${rawKey}` },
      data: { business_phone: "+44 20 7946 0000" }, // UK number, not US/CA
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toContain("US/CA");
  });

  test("requests over the per-key rate limit get 429", async ({ baseURL }) => {
    // Use a dedicated key so we don't disturb the other tests' counts, and
    // pre-seed its current-window counter to the limit (120) so the very
    // next request is the one that crosses the threshold — far faster and
    // less flaky than actually firing 121 requests.
    const random = randomBytes(24)
      .toString("base64url")
      .replace(/=+$/g, "")
      .slice(0, 32);
    const rlRawKey = `sk_${random}`;
    const { data: rlKey } = await admin
      .from("api_keys")
      .insert({
        owner_id: ownerId,
        name: `E2E RL key ${stamp}`,
        key_prefix: random.slice(0, 8),
        key_hash: createHash("sha256").update(random).digest("hex"),
      })
      .select("id")
      .single();

    // Floor now() to the same 60s window the route uses.
    const windowStart = new Date(
      Math.floor(Date.now() / 1000 / 60) * 60 * 1000,
    ).toISOString();
    await admin.from("api_rate_limits").insert({
      api_key_id: rlKey!.id,
      window_start: windowStart,
      request_count: 120,
    });

    try {
      const api = await playwrightRequest.newContext({ baseURL });
      const r = await api.post("/api/v1/leads", {
        headers: { authorization: `Bearer ${rlRawKey}` },
        data: { business_phone: `+1777${tail}9` },
      });
      expect(r.status()).toBe(429);
      expect(r.headers()["retry-after"]).toBeTruthy();
      const body = await r.json();
      expect(body.error).toBe("rate_limited");
    } finally {
      await admin.from("api_rate_limits").delete().eq("api_key_id", rlKey!.id);
      await admin.from("api_keys").delete().eq("id", rlKey!.id);
    }
  });
});
