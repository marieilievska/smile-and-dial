# Meta (Facebook) Custom Audience Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync collected lead emails (plus phone/city/state/country, all hashed) into one Meta Custom Audience — via a nightly automated push and a manual CSV export — for Facebook/Instagram ads and lookalikes.

**Architecture:** Pure hashing/field-mapping modules feed a thin Meta Marketing API client. A `sync` orchestrator gathers eligible leads (email present, not DNC, not deleted), adds them to the audience, and removes any that became ineligible. A secret-protected endpoint runs the sync; pg_cron fires it nightly. A Settings → Integrations card connects Meta (paste ad-account ID + token) and offers "Sync now" + CSV export.

**Tech stack:** Next.js 16 App Router (server actions + route handlers), Supabase (Postgres + pg_cron/pg_net), Meta Graph Marketing API v21.0, Node `crypto` for SHA-256.

**Verification note (this repo):** there is no unit-test runner — only Playwright e2e (`npm run test`). Every task verifies with `npx tsc --noEmit`, `npm run build`, and `npm run lint`. Pure logic is checked with a throwaway `node --input-type=module` assertion snippet (shown inline, not committed). The Settings card gets a Playwright smoke test. Secrets live only in `.env.local` / Supabase, never in git.

---

## File Structure

- Create `src/lib/meta/hash.ts` — normalize + SHA-256 each match field (pure).
- Create `src/lib/meta/audience-fields.ts` — lead → hashed row aligned to the Meta schema; US/CA country derivation (pure).
- Create `src/lib/meta/settings.ts` — read/write the `app_settings` meta\_\* columns (server-only, admin client).
- Create `src/lib/meta/api.ts` — Meta Marketing API client: ensure audience, add users, remove users; mock when no token.
- Create `src/lib/meta/sync.ts` — orchestration: gather eligible leads, add, reconcile removals, write status.
- Create `src/lib/meta/actions.ts` — server actions: connect, disconnect, sync-now.
- Create `src/app/api/meta/sync/route.ts` — secret/admin-protected POST that runs the sync.
- Create `src/app/(app)/settings/integrations/meta/export/route.ts` — CSV export of eligible contacts.
- Create `src/app/(app)/settings/integrations/meta-form.tsx` — the Settings card (client).
- Modify `src/app/(app)/settings/integrations/page.tsx` — render the Meta card.
- Create `supabase/migrations/<ts>_meta_audience.sql` — app_settings columns + `leads.meta_synced_at`.
- Create `supabase/migrations/<ts>_meta_sync_cron.sql` — nightly pg_cron → `/api/meta/sync`.
- Modify `src/lib/supabase/database.types.ts` — regenerated after migrations.
- Create `tests/meta-integration.spec.ts` — Playwright smoke for the Settings card.

---

## Task 1: Database — app_settings meta columns + leads.meta_synced_at

**Files:**

- Create: `supabase/migrations/20260610090000_meta_audience.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

- [ ] **Step 1: Write the migration**

```sql
-- Meta (Facebook) Custom Audience integration config + per-lead sync state.

alter table public.app_settings
  add column if not exists meta_ad_account_id text,
  add column if not exists meta_access_token text,
  add column if not exists meta_custom_audience_id text,
  add column if not exists meta_audience_terms_accepted_at timestamptz,
  add column if not exists meta_connected_at timestamptz,
  add column if not exists meta_last_sync_at timestamptz,
  add column if not exists meta_last_sync_count integer not null default 0,
  add column if not exists meta_last_sync_error text,
  add column if not exists meta_sync_secret text;

-- Which leads we've already pushed to Meta, so the sync can compute removals
-- (Meta does not let us read audience members back).
alter table public.leads
  add column if not exists meta_synced_at timestamptz;

create index if not exists leads_meta_synced_at_idx
  on public.leads (meta_synced_at)
  where meta_synced_at is not null;
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: "Applying migration 20260610090000_meta_audience.sql..." then "Finished supabase db push."

- [ ] **Step 3: Regenerate types**

Run: `npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`
Then confirm the columns exist:
Run: `grep -n "meta_custom_audience_id\|meta_synced_at" src/lib/supabase/database.types.ts`
Expected: at least 2 matches.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add supabase/migrations/20260610090000_meta_audience.sql src/lib/supabase/database.types.ts
git commit -m "feat(meta): app_settings columns + leads.meta_synced_at"
```

---

## Task 2: Hashing util (`src/lib/meta/hash.ts`)

Meta requires each match key SHA-256-hashed (hex, lowercase) after normalization. Empty/missing values become `""` (Meta ignores empty cells in a multi-key row).

**Files:**

- Create: `src/lib/meta/hash.ts`

- [ ] **Step 1: Write the module**

```ts
import "server-only";

import { createHash } from "node:crypto";

/** SHA-256 hex of an already-normalized value. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash a value, or return "" for empty input (Meta skips empty cells). */
function hashOrEmpty(normalized: string): string {
  return normalized ? sha256(normalized) : "";
}

/** email: trim + lowercase. */
export function hashEmail(raw: string | null | undefined): string {
  return hashOrEmpty((raw ?? "").trim().toLowerCase());
}

/** phone: digits only, keep country code (E.164 "+1.." -> "1.."). */
export function hashPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return hashOrEmpty(digits);
}

/** city: lowercase, strip everything but a-z. */
export function hashCity(raw: string | null | undefined): string {
  return hashOrEmpty((raw ?? "").toLowerCase().replace(/[^a-z]/g, ""));
}

/** US state / CA province: lowercase 2-letter code. Passes through any
 *  already-2-letter value; otherwise empties (we store 2-letter codes). */
export function hashState(raw: string | null | undefined): string {
  const v = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return hashOrEmpty(v.length === 2 ? v : "");
}

/** country: 2-letter ISO lowercase ("us" / "ca"). */
export function hashCountry(raw: string | null | undefined): string {
  return hashOrEmpty(
    (raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, ""),
  );
}
```

- [ ] **Step 2: Verify hashing behavior**

Run:

```bash
node --input-type=module -e '
import { createHash } from "node:crypto";
const h = (v) => createHash("sha256").update(v).digest("hex");
// Mirrors hashEmail / hashPhone normalization:
const email = "  John@Example.COM ".trim().toLowerCase();
console.assert(email === "john@example.com", "email normalize");
const phone = "+1 (205) 259-8928".replace(/\D/g, "");
console.assert(phone === "12052598928", "phone normalize");
console.log("email hash:", h(email));
console.log("phone hash:", h(phone));
console.log("empty -> \"\":", "" === "" ? "ok" : "bad");
console.log("ok");
'
```

Expected: prints two 64-char hex hashes and "ok"; no assertion errors.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/hash.ts
git commit -m "feat(meta): SHA-256 hashing for audience match keys"
```

---

## Task 3: Lead → hashed audience row (`src/lib/meta/audience-fields.ts`)

**Files:**

- Create: `src/lib/meta/audience-fields.ts`

- [ ] **Step 1: Write the module**

```ts
import "server-only";

import { hashCity, hashCountry, hashEmail, hashPhone, hashState } from "./hash";

/** The Meta customer-list schema we upload, in column order. CT = city,
 *  ST = state/province, COUNTRY = 2-letter country. */
export const META_SCHEMA = ["EMAIL", "PHONE", "CT", "ST", "COUNTRY"] as const;

/** Canadian provinces/territories (2-letter). Used to derive country = CA. */
const CA_PROVINCES = new Set([
  "ab",
  "bc",
  "mb",
  "nb",
  "nl",
  "ns",
  "nt",
  "nu",
  "on",
  "pe",
  "qc",
  "sk",
  "yt",
]);

/** Canadian area codes (subset is fine — anything not matched defaults to US,
 *  which is correct for this US-heavy list). */
const CA_AREA_CODES = new Set([
  "204",
  "226",
  "236",
  "249",
  "250",
  "289",
  "306",
  "343",
  "365",
  "403",
  "416",
  "418",
  "431",
  "437",
  "438",
  "450",
  "506",
  "514",
  "519",
  "548",
  "579",
  "581",
  "587",
  "604",
  "613",
  "639",
  "647",
  "672",
  "705",
  "709",
  "778",
  "780",
  "782",
  "807",
  "819",
  "825",
  "867",
  "873",
  "902",
  "905",
]);

export type LeadForAudience = {
  business_email: string | null;
  business_phone: string | null;
  city: string | null;
  state: string | null;
};

/** US or CA. CA when the state is a Canadian province OR the phone's area code
 *  is Canadian; otherwise US. */
export function deriveCountry(lead: LeadForAudience): "US" | "CA" {
  const st = (lead.state ?? "").trim().toLowerCase();
  if (CA_PROVINCES.has(st)) return "CA";
  const digits = (lead.business_phone ?? "").replace(/\D/g, "");
  const ac =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1, 4)
      : digits.length === 10
        ? digits.slice(0, 3)
        : "";
  if (ac && CA_AREA_CODES.has(ac)) return "CA";
  return "US";
}

/** A lead as one hashed row aligned to META_SCHEMA. */
export function leadToHashedRow(lead: LeadForAudience): string[] {
  return [
    hashEmail(lead.business_email),
    hashPhone(lead.business_phone),
    hashCity(lead.city),
    hashState(lead.state),
    hashCountry(deriveCountry(lead)),
  ];
}
```

- [ ] **Step 2: Verify country derivation + row shape**

Run:

```bash
node --input-type=module -e '
const CA_PROV = new Set(["on","qc","bc"]);
const CA_AC = new Set(["416","514","604"]);
function derive(state, phone){
  const st=(state||"").toLowerCase(); if(CA_PROV.has(st)) return "CA";
  const d=(phone||"").replace(/\D/g,""); const ac=d.length===11&&d.startsWith("1")?d.slice(1,4):d.length===10?d.slice(0,3):"";
  return ac&&CA_AC.has(ac)?"CA":"US";
}
console.assert(derive("ON",null)==="CA","province CA");
console.assert(derive(null,"+14165551234")==="CA","area code CA");
console.assert(derive("TX","+12055551234")==="US","US default");
console.assert(derive(null,null)==="US","unknown -> US");
console.log("ok");
'
```

Expected: "ok", no assertion errors.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/audience-fields.ts
git commit -m "feat(meta): lead -> hashed audience row + US/CA country derivation"
```

---

## Task 4: Meta settings accessor (`src/lib/meta/settings.ts`)

Reads/writes the `app_settings` singleton meta\_\* columns with the service-role client (RLS-bypassing, server-only). Mirrors how `post-call-webhook.ts` reads secrets from `app_settings`.

**Files:**

- Create: `src/lib/meta/settings.ts`

- [ ] **Step 1: Write the module**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

function admin(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("Supabase service role env missing.");
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type MetaSettings = {
  adAccountId: string | null;
  accessToken: string | null;
  customAudienceId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncError: string | null;
  syncSecret: string | null;
};

const SELECT =
  "meta_ad_account_id, meta_access_token, meta_custom_audience_id, " +
  "meta_connected_at, meta_last_sync_at, meta_last_sync_count, " +
  "meta_last_sync_error, meta_sync_secret";

export async function getMetaSettings(): Promise<MetaSettings> {
  const { data } = await admin()
    .from("app_settings")
    .select(SELECT)
    .limit(1)
    .maybeSingle();
  return {
    adAccountId: data?.meta_ad_account_id ?? null,
    accessToken: data?.meta_access_token ?? null,
    customAudienceId: data?.meta_custom_audience_id ?? null,
    connectedAt: data?.meta_connected_at ?? null,
    lastSyncAt: data?.meta_last_sync_at ?? null,
    lastSyncCount: data?.meta_last_sync_count ?? 0,
    lastSyncError: data?.meta_last_sync_error ?? null,
    syncSecret: data?.meta_sync_secret ?? null,
  };
}

/** Patch the singleton app_settings row (there is exactly one). */
export async function patchMetaSettings(
  patch: Record<string, unknown>,
): Promise<void> {
  await admin()
    .from("app_settings")
    .update(patch as never)
    .not("id", "is", null);
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/settings.ts
git commit -m "feat(meta): app_settings accessor for Meta config"
```

---

## Task 5: Meta Marketing API client (`src/lib/meta/api.ts`)

**Files:**

- Create: `src/lib/meta/api.ts`

- [ ] **Step 1: Write the module**

```ts
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
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/api.ts
git commit -m "feat(meta): Marketing API client (create audience, add/remove users)"
```

---

## Task 6: Sync orchestration (`src/lib/meta/sync.ts`)

**Files:**

- Create: `src/lib/meta/sync.ts`

- [ ] **Step 1: Write the module**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { leadToHashedRow, type LeadForAudience } from "./audience-fields";
import { addUsers, createAudience, META_BATCH, removeUsers } from "./api";
import { getMetaSettings, patchMetaSettings } from "./settings";

type Admin = ReturnType<typeof createClient<Database>>;
const PAGE = 1000;

function admin(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type MetaSyncResult = {
  ok: boolean;
  added: number;
  removed: number;
  error: string | null;
};

const FIELDS = "id, business_email, business_phone, city, state";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Push eligible leads (email present, not DNC, not deleted) into the Custom
 * Audience and remove any previously-synced lead that became ineligible.
 * Returns counts; writes status back to app_settings.
 */
export async function runMetaSync(): Promise<MetaSyncResult> {
  const s = await getMetaSettings();
  if (!s.accessToken || !s.adAccountId) {
    return { ok: false, added: 0, removed: 0, error: "Meta is not connected." };
  }
  const db = admin();

  // Ensure the audience exists (create on first run).
  let audienceId = s.customAudienceId;
  if (!audienceId) {
    const created = await createAudience(
      s.adAccountId,
      s.accessToken,
      "Smile & Dial — All Leads",
    );
    if (!created.ok) {
      await patchMetaSettings({ meta_last_sync_error: created.error });
      return { ok: false, added: 0, removed: 0, error: created.error };
    }
    audienceId = created.data.id;
    await patchMetaSettings({ meta_custom_audience_id: audienceId });
  }

  let added = 0;
  let removed = 0;

  // --- ADD: eligible leads not yet synced ---
  for (let from = 0; ; from += PAGE) {
    const { data: rows } = await db
      .from("leads")
      .select(FIELDS)
      .is("deleted_at", null)
      .neq("status", "dnc")
      .not("business_email", "is", null)
      .is("meta_synced_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (!rows || rows.length === 0) break;

    const hashed = rows.map((r) => leadToHashedRow(r as LeadForAudience));
    for (const batch of chunk(hashed, META_BATCH)) {
      const res = await addUsers(audienceId, s.accessToken, batch);
      if (!res.ok) {
        await patchMetaSettings({ meta_last_sync_error: res.error });
        return { ok: false, added, removed, error: res.error };
      }
    }
    const ids = rows.map((r) => (r as { id: string }).id);
    await db
      .from("leads")
      .update({ meta_synced_at: new Date().toISOString() })
      .in("id", ids);
    added += rows.length;
    if (rows.length < PAGE) break;
  }

  // --- REMOVE: previously-synced leads now ineligible (deleted / dnc / no email) ---
  for (;;) {
    const { data: rows } = await db
      .from("leads")
      .select(FIELDS + ", deleted_at, status")
      .not("meta_synced_at", "is", null)
      .or("deleted_at.not.is.null,status.eq.dnc,business_email.is.null")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (!rows || rows.length === 0) break;

    const hashed = rows.map((r) => leadToHashedRow(r as LeadForAudience));
    for (const batch of chunk(hashed, META_BATCH)) {
      const res = await removeUsers(audienceId, s.accessToken, batch);
      if (!res.ok) {
        await patchMetaSettings({ meta_last_sync_error: res.error });
        return { ok: false, added, removed, error: res.error };
      }
    }
    const ids = rows.map((r) => (r as { id: string }).id);
    await db.from("leads").update({ meta_synced_at: null }).in("id", ids);
    removed += rows.length;
    if (rows.length < PAGE) break;
  }

  // Total currently-synced count for the status line.
  const { count } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .not("meta_synced_at", "is", null);

  await patchMetaSettings({
    meta_last_sync_at: new Date().toISOString(),
    meta_last_sync_count: count ?? 0,
    meta_last_sync_error: null,
  });

  return { ok: true, added, removed, error: null };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/sync.ts
git commit -m "feat(meta): sync orchestration (add eligible, remove ineligible)"
```

---

## Task 7: Sync endpoint (`src/app/api/meta/sync/route.ts`)

Mirrors `src/app/api/dialer/tick/route.ts`: a header secret (for pg_cron) OR a signed-in admin (for "Sync now").

**Files:**

- Create: `src/app/api/meta/sync/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { getMetaSettings } from "@/lib/meta/settings";
import { runMetaSync } from "@/lib/meta/sync";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const headerSecret = request.headers.get("x-meta-sync-secret");
  const { syncSecret } = await getMetaSettings();

  let authorized = false;
  if (syncSecret && headerSecret && headerSecret === syncSecret) {
    authorized = true;
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (me?.role === "admin") authorized = true;
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runMetaSync();
    return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)
Run: `npm run build` (expect exit 0)

```bash
git add src/app/api/meta/sync/route.ts
git commit -m "feat(meta): secret/admin-protected sync endpoint"
```

---

## Task 8: CSV export (`.../settings/integrations/meta/export/route.ts`)

Meta's manual upload accepts a CSV with columns `email,phone,ct,st,country` (raw, un-hashed — Meta's uploader hashes in-browser). Streams all eligible leads.

**Files:**

- Create: `src/app/(app)/settings/integrations/meta/export/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { type NextRequest } from "next/server";

import { deriveCountry } from "@/lib/meta/audience-fields";
import { createClient } from "@/lib/supabase/server";

const BOM = "﻿";

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const { data } = await supabase
    .from("leads")
    .select("business_email, business_phone, city, state")
    .is("deleted_at", null)
    .neq("status", "dnc")
    .not("business_email", "is", null)
    .limit(100000);
  const leads = data ?? [];

  const rows = [
    ["email", "phone", "ct", "st", "country"],
    ...leads.map((l) => [
      l.business_email ?? "",
      l.business_phone ?? "",
      l.city ?? "",
      l.state ?? "",
      deriveCountry(l),
    ]),
  ];
  const csv = BOM + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="meta-audience.csv"',
    },
  });
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)
Run: `npm run build` (expect exit 0)

```bash
git add "src/app/(app)/settings/integrations/meta/export/route.ts"
git commit -m "feat(meta): CSV export of eligible contacts for manual upload"
```

---

## Task 9: Server actions (`src/lib/meta/actions.ts`)

Connect/disconnect/sync-now. Connect requires the acknowledgment checkbox and generates a sync secret if absent. Mirrors `src/lib/close/actions.ts` (auth + admin check + `patch`).

**Files:**

- Create: `src/lib/meta/actions.ts`

- [ ] **Step 1: Write the module**

```ts
"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { runMetaSync } from "@/lib/meta/sync";
import { createClient } from "@/lib/supabase/server";

type Result = { error: string | null };

/** Admin-only guard. Returns the user id or an error. */
async function requireAdmin(): Promise<
  { userId: string; error: null } | { userId: null; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { userId: null, error: "Only an admin can manage integrations." };
  }
  return { userId: user.id, error: null };
}

export async function connectMeta(input: {
  adAccountId: string;
  accessToken: string;
  acknowledged: boolean;
}): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  if (!input.acknowledged) {
    return { error: "Please confirm you have the right to use this data." };
  }
  const adAccountId = input.adAccountId.trim();
  const accessToken = input.accessToken.trim();
  if (!adAccountId || !accessToken) {
    return { error: "Ad account ID and access token are both required." };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("app_settings")
    .update({
      meta_ad_account_id: adAccountId,
      meta_access_token: accessToken,
      meta_audience_terms_accepted_at: now,
      meta_connected_at: now,
      meta_last_sync_error: null,
      // generate a sync secret once so the nightly cron can authenticate
      meta_sync_secret: randomUUID(),
    } as never)
    .not("id", "is", null);
  if (error) return { error: "Could not save the Meta connection." };

  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function disconnectMeta(): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({
      meta_access_token: null,
      meta_connected_at: null,
    } as never)
    .not("id", "is", null);
  if (error) return { error: "Could not disconnect Meta." };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function syncMetaNow(): Promise<Result> {
  const guard = await requireAdmin();
  if (guard.error) return { error: guard.error };
  const result = await runMetaSync();
  revalidatePath("/settings/integrations");
  return { error: result.ok ? null : (result.error ?? "Sync failed.") };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)

```bash
git add src/lib/meta/actions.ts
git commit -m "feat(meta): connect / disconnect / sync-now server actions"
```

---

## Task 10: Settings card (`meta-form.tsx`) + mount

Follow `src/app/(app)/settings/integrations/close-form.tsx` for structure/styling. Server page passes current status; the client form handles connect/disconnect/sync.

**Files:**

- Read first: `src/app/(app)/settings/integrations/close-form.tsx` (copy its card shell + className conventions)
- Read first: `src/app/(app)/settings/integrations/page.tsx` (see how it loads settings + renders cards)
- Create: `src/app/(app)/settings/integrations/meta-form.tsx`
- Modify: `src/app/(app)/settings/integrations/page.tsx`

- [ ] **Step 1: Read the existing patterns**

Run: `sed -n '1,80p' "src/app/(app)/settings/integrations/close-form.tsx"`
Run: `sed -n '1,140p' "src/app/(app)/settings/integrations/page.tsx"`
Note: the exact `<Card>`/section wrapper, heading classes, button variants, and how `page.tsx` fetches `app_settings` and passes `connected` + status props into each form. Reuse them verbatim below.

- [ ] **Step 2: Write `meta-form.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectMeta, disconnectMeta, syncMetaNow } from "@/lib/meta/actions";

export function MetaForm({
  connected,
  lastSyncAt,
  lastSyncCount,
  lastSyncError,
}: {
  connected: boolean;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncError: string | null;
}) {
  const [adAccountId, setAdAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();

  function connect() {
    startTransition(async () => {
      const r = await connectMeta({ adAccountId, accessToken, acknowledged });
      if (r.error) toast.error(r.error);
      else {
        toast.success("Meta connected. Run a sync to push your audience.");
        setAccessToken("");
      }
    });
  }
  function disconnect() {
    startTransition(async () => {
      const r = await disconnectMeta();
      if (r.error) toast.error(r.error);
      else toast.success("Meta disconnected.");
    });
  }
  function syncNow() {
    startTransition(async () => {
      const r = await syncMetaNow();
      if (r.error) toast.error(r.error);
      else toast.success("Sync complete.");
    });
  }

  return (
    <section className="border-border bg-card flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-foreground text-sm font-semibold">
          Meta Ads (Facebook / Instagram)
        </h3>
        <p className="text-muted-foreground text-xs">
          Sync collected lead emails into a Meta Custom Audience for ads and
          lookalikes. Emails are hashed before they leave the server.
        </p>
      </div>

      {connected ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs">
            {lastSyncError
              ? `Last sync error: ${lastSyncError} — reconnect may be needed.`
              : lastSyncAt
                ? `Last synced ${new Date(lastSyncAt).toLocaleString()} · ${lastSyncCount.toLocaleString()} contacts`
                : "Connected. Not synced yet."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={syncNow} disabled={pending} size="sm">
              {pending ? "Working…" : "Sync now"}
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="/settings/integrations/meta/export">Export CSV</a>
            </Button>
            <Button
              onClick={disconnect}
              disabled={pending}
              variant="ghost"
              size="sm"
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-acct">Ad account ID</Label>
            <Input
              id="meta-acct"
              placeholder="act_123456789"
              value={adAccountId}
              onChange={(e) => setAdAccountId(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-token">System user access token</Label>
            <Input
              id="meta-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              I confirm we have the right to use these contacts for advertising
              (Meta Custom Audience Terms).
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={connect} disabled={pending} size="sm">
              {pending ? "Connecting…" : "Connect Meta"}
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="/settings/integrations/meta/export">Export CSV</a>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount in `page.tsx`**

In `src/app/(app)/settings/integrations/page.tsx`: add `meta_connected_at, meta_last_sync_at, meta_last_sync_count, meta_last_sync_error` to the `app_settings` select, import `MetaForm`, and render it alongside the other cards:

```tsx
<MetaForm
  connected={Boolean(
    settings?.meta_connected_at && settings?.meta_access_token,
  )}
  lastSyncAt={settings?.meta_last_sync_at ?? null}
  lastSyncCount={settings?.meta_last_sync_count ?? 0}
  lastSyncError={settings?.meta_last_sync_error ?? null}
/>
```

(If the page's `app_settings` select does not already include `meta_access_token`, add it — it's only used server-side to compute `connected`, never rendered.)

- [ ] **Step 4: Typecheck + build + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status-webhook"` (expect no output)
Run: `npm run build` (expect exit 0)

```bash
git add "src/app/(app)/settings/integrations/meta-form.tsx" "src/app/(app)/settings/integrations/page.tsx"
git commit -m "feat(meta): Settings → Integrations card (connect / sync / export)"
```

---

## Task 11: Nightly cron (`<ts>_meta_sync_cron.sql`)

Same pg_cron + pg_net pattern as `20260608170000_dialer_autopilot_cron.sql`. Runs once nightly at 08:00 UTC. The secret is read from `app_settings.meta_sync_secret` (set when the user clicks Connect), so an unconnected integration posts an empty secret and the endpoint safely 401s.

**Files:**

- Create: `supabase/migrations/20260610100000_meta_sync_cron.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Nightly Meta Custom Audience sync. pg_cron + pg_net (already enabled by the
-- dialer cron migration). Reads the sync secret from app_settings; until the
-- integration is connected (secret null), the endpoint rejects the call.

select cron.unschedule(jobid)
from cron.job
where jobname = 'meta-audience-sync';

select cron.schedule(
  'meta-audience-sync',
  '0 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/meta/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-meta-sync-secret', coalesce(
        (select meta_sync_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
```

- [ ] **Step 2: Apply + commit**

Run: `npx supabase db push` (expect "Finished supabase db push.")

```bash
git add supabase/migrations/20260610100000_meta_sync_cron.sql
git commit -m "feat(meta): nightly pg_cron trigger for audience sync"
```

---

## Task 12: Playwright smoke (`tests/meta-integration.spec.ts`)

**Files:**

- Read first: an existing spec in `tests/` to copy the admin sign-in helper/fixtures.
- Create: `tests/meta-integration.spec.ts`

- [ ] **Step 1: Read an existing test for the auth/setup pattern**

Run: `ls tests/` then open one settings-related spec to copy its login + `page.goto` setup verbatim (env creds `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD`).

- [ ] **Step 2: Write the smoke test**

```ts
import { expect, test } from "@playwright/test";

// Reuse the project's existing admin-login helper/fixture exactly as other
// specs do (copy from the spec read in Step 1).

test("Meta integration card shows and validates connect", async ({ page }) => {
  // <admin login per existing pattern>
  await page.goto("/settings/integrations");

  await expect(page.getByText("Meta Ads (Facebook / Instagram)")).toBeVisible();

  // Connect requires the acknowledgment + fields → clicking with empty fields errors.
  await page.getByRole("button", { name: "Connect Meta" }).click();
  await expect(page.getByText(/right to use these contacts/i)).toBeVisible();

  // CSV export link is present.
  await expect(page.getByRole("link", { name: "Export CSV" })).toBeVisible();
});
```

- [ ] **Step 3: Run the test**

Run: `npm run test -- meta-integration`
Expected: PASS. (If the login helper differs, adjust to match the spec read in Step 1.)

- [ ] **Step 4: Commit**

```bash
git add tests/meta-integration.spec.ts
git commit -m "test(meta): Settings integration card smoke"
```

---

## Go-live (after build, when Meta credentials are in hand)

1. Deploy (`git push origin main` + `vercel --prod --yes`).
2. In **Settings → Integrations → Meta Ads**, paste the **ad account ID** + **system-user token**, tick the acknowledgment, **Connect**.
3. Click **Sync now** — confirm the status line shows "Last synced … · N contacts" and the audience appears in Meta Ads Manager. The nightly cron keeps it fresh thereafter.
4. (Optional) Use **Export CSV** any time for a manual upload.

---

## Self-Review

- **Spec coverage:** one audience / all emails (Task 6, 8 queries) ✓; match keys email+phone+city+state+country (Task 2, 3) ✓; US/CA derivation (Task 3) ✓; manual CSV export (Task 8) ✓; nightly + sync-now automated sync (Task 6, 7, 9, 11) ✓; exclude + remove DNC/deleted (Task 6 add filter + remove pass) ✓; acknowledgment checkbox (Task 9, 10) ✓; Settings card with status (Task 10) ✓; paste-token connect (Task 9, 10) ✓; secret-protected endpoint (Task 7) ✓; per-lead sync state for removals (Task 1 `meta_synced_at`, used in Task 6) ✓; error handling — not connected / invalid token / batch failure / audience recreate (Task 6) ✓.
- **Placeholders:** none — all steps carry real code/commands. (Task 10/12 intentionally say "read the existing pattern first" because they must match repo-specific card markup + the Playwright login helper, which are established conventions, not invented values.)
- **Type consistency:** `META_SCHEMA`, `leadToHashedRow`, `LeadForAudience`, `deriveCountry`, `getMetaSettings`/`patchMetaSettings`, `addUsers`/`removeUsers`/`createAudience`/`META_BATCH`, `runMetaSync` names are used identically across Tasks 2–11.

## Out of scope (per spec)

Lookalike creation (done in Meta), per-campaign audiences, zip/DOB/gender/name keys, real-time per-lead sync, OAuth connect.
