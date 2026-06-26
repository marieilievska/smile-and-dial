# Reporting redesign Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the Reporting sentiment features to any campaign — the Dashboard sentiment columns and the Voice of Customer tab auto-detect each campaign's own categorical + free-text fields — and add inline call-recording playback (incl. the public share) plus clickable lead names (admin only). The public share becomes scope-aware with a read-only campaign picker.

**Architecture:** A new `field-detect.ts` samples a campaign's `extracted_data` to pick a sentiment field (small value set) and a notes field (longest text), with a word-list for ordering/colors/Warm%. `DailyKpi` and the dashboard render dynamic per-value columns. Voice of Customer is rebuilt around `{sentiment, notes, recording, leadId}`. Recordings stream via two tiny redirect routes (admin + token-gated public).

**Tech Stack:** Next.js (App Router/RSC + route handlers), Supabase (PostgREST + Storage signed URLs), shadcn, Playwright (live-env contract tests).

**Testing note:** No local test runner — Playwright runs against the live env only. Each task verifies with `npx tsc --noEmit` + `npx eslint <files>` (and `npm run build` on page tasks). Shared-signature changes mean `tsc` shows transient call-site errors mid-plan; it must be clean (except the 3 pre-existing `twilio-*.spec.ts` errors) after the final task.

**Branch:** `feat/reporting-phase2-voice-generalized` (created; spec committed). **No DB migration.**

---

## File structure

- **Create** `src/lib/agent-analytics/field-detect.ts` — detection + sentiment lexicon helpers.
- **Modify** `src/lib/agent-analytics/stats.ts` — `DailyKpi.sentimentCounts`; `computeDailyKpis(rows, sentimentKey?)`.
- **Modify** `src/lib/agent-analytics/report-data.ts` — `VoiceRow` reshape; `fetchVoiceRows(scope, detected)`; `fetchDashboardKpis(scope, sentimentKey?)`.
- **Modify** `src/app/(app)/reporting/dashboard-view.tsx` — dynamic sentiment columns from `sentimentValues`.
- **Rewrite** `src/app/(app)/reporting/voice-table.tsx` — sentiment pill + notes + recording + lead link.
- **Create** `src/app/api/reporting/recording/[callId]/route.ts` — admin recording redirect.
- **Create** `src/app/share/reporting/[token]/recording/[callId]/route.ts` — token-gated recording redirect.
- **Modify** `src/app/(app)/reporting/scope-picker.tsx` — `basePath` prop.
- **Modify** `src/app/(app)/reporting/reporting-tabs.tsx` — `reportingTabsFor({showVoice, showHotLeads})`.
- **Modify** `src/app/(app)/reporting/page.tsx` — detection wiring, dynamic dashboard + voice, lead links.
- **Modify** `src/app/share/reporting/[token]/page.tsx` — scope-aware + read-only picker + recordings.
- **Modify** `tests/reporting-scope.spec.ts` (or add `reporting-voice.spec.ts`) — contract.

---

## Task 1: Detection helper + lexicon

**Files:** Create `src/lib/agent-analytics/field-detect.ts`

- [ ] **Step 1: Write the file**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type DB = SupabaseClient<Database>;

/** Standard data-collection fields every agent emits — excluded from per-campaign
 *  sentiment/notes detection (we want the agent's CUSTOM fields). Mirrors the
 *  DATA_COLLECTION_FIELDS ids in src/lib/elevenlabs/agents.ts. */
const STANDARD_KEYS = new Set([
  "disposition",
  "decision_maker_reached",
  "business_email",
  "owner_name",
  "manager_name",
  "employee_name",
  "callback_datetime",
]);

const POSITIVE = new Set([
  "yes",
  "happy",
  "good",
  "great",
  "interested",
  "satisfied",
  "positive",
]);
const NEUTRAL = new Set(["maybe", "mixed", "neutral", "unsure", "somewhat"]);
const NEGATIVE = new Set([
  "no",
  "unhappy",
  "bad",
  "not_interested",
  "dissatisfied",
  "negative",
]);

/** Lexicon rank: positive(0) < neutral(1) < negative(2) < unrecognized(3). */
export function sentimentRank(v: string): number {
  const s = v.trim().toLowerCase();
  if (POSITIVE.has(s)) return 0;
  if (NEUTRAL.has(s)) return 1;
  if (NEGATIVE.has(s)) return 2;
  return 3;
}

/** Warm = positive or neutral. */
export function isWarm(v: string): boolean {
  return sentimentRank(v) <= 1;
}

/** Tailwind classes for a sentiment pill, by lexicon (neutral gray fallback). */
export function sentimentTone(v: string): string {
  switch (sentimentRank(v)) {
    case 0:
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case 1:
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case 2:
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
    default:
      return "bg-muted text-foreground";
  }
}

export type DetectedFields = {
  sentimentKey: string | null;
  sentimentValues: string[]; // ordered by lexicon then alphabetical
  notesKey: string | null;
};

const SAMPLE_DAYS = 90;
const PAGE = 1000;

/** Inspect a campaign's recent calls and pick its sentiment field (a custom
 *  field with a small value set) and notes field (longest free text). Returns
 *  nulls when nothing qualifies. */
export async function detectCampaignFields(
  supabase: DB,
  campaignId: string,
): Promise<DetectedFields> {
  const since = new Date(Date.now() - SAMPLE_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("calls")
    .select("extracted_data")
    .eq("campaign_id", campaignId)
    .eq("direction", "outbound")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .range(0, PAGE - 1);
  const rows = (data ?? []) as { extracted_data: unknown }[];

  const distinct = new Map<string, Set<string>>(); // key -> lowercased values
  const text = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const ed =
      r.extracted_data && typeof r.extracted_data === "object"
        ? (r.extracted_data as Record<string, unknown>)
        : {};
    for (const [key, raw] of Object.entries(ed)) {
      if (STANDARD_KEYS.has(key)) continue;
      const val = String(raw ?? "").trim();
      if (!val) continue;
      if (!distinct.has(key)) distinct.set(key, new Set());
      distinct.get(key)!.add(val.toLowerCase());
      const t = text.get(key) ?? { total: 0, count: 0 };
      t.total += val.length;
      t.count++;
      text.set(key, t);
    }
  }

  // sentimentKey: 2–6 distinct values; prefer most lexicon-recognized, then
  // fewest distinct, then alphabetical key (deterministic).
  let sentimentKey: string | null = null;
  let best = { recognized: -1, size: Infinity, key: "~" };
  for (const [key, vals] of distinct) {
    const size = vals.size;
    if (size < 2 || size > 6) continue;
    const recognized = [...vals].filter((v) => sentimentRank(v) < 3).length;
    const better =
      recognized > best.recognized ||
      (recognized === best.recognized && size < best.size) ||
      (recognized === best.recognized && size === best.size && key < best.key);
    if (better) {
      best = { recognized, size, key };
      sentimentKey = key;
    }
  }
  const sentimentValues = sentimentKey
    ? [...distinct.get(sentimentKey)!].sort(
        (a, b) => sentimentRank(a) - sentimentRank(b) || a.localeCompare(b),
      )
    : [];

  // notesKey: longest average text (≥ 20 chars), excluding the sentiment key.
  let notesKey: string | null = null;
  let bestAvg = 0;
  for (const [key, t] of text) {
    if (key === sentimentKey || t.count === 0) continue;
    const avg = t.total / t.count;
    if (avg >= 20 && avg > bestAvg) {
      bestAvg = avg;
      notesKey = key;
    }
  }

  return { sentimentKey, sentimentValues, notesKey };
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (no new errors from this file); `npx eslint src/lib/agent-analytics/field-detect.ts` clean.
- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-analytics/field-detect.ts
git commit -m "feat(reporting): per-campaign sentiment/notes field detection"
```

---

## Task 2: Generalize the daily KPI math

**Files:** Modify `src/lib/agent-analytics/stats.ts`

- [ ] **Step 1: Replace the `DailyKpi` interest fields with `sentimentCounts`**

In the `DailyKpi` type, remove `interestYes`, `interestMaybe`, `interestNo` and add (keep `warmPct`):

```ts
/** Per-day counts keyed by the campaign's lowercased sentiment value
 *  (e.g. { yes: 3, maybe: 1, no: 2 }). Empty when no sentiment field. */
sentimentCounts: Record<string, number>;
/** (warm answers) / (total answered), 0..1; warm = positive or neutral. */
warmPct: number;
```

In `emptyDay`, replace the three `interest*: 0` lines with `sentimentCounts: {},`.

- [ ] **Step 2: Generalize `computeDailyKpis`**

Add an `import { isWarm } from "./field-detect";` at the top. Replace the `computeDailyKpis` signature + the interest-counting + warmPct loop:

```ts
/** Group calls into per-ET-day KPI rows, newest day first. When `sentimentKey`
 *  is given, also bucket each call's extracted_data[sentimentKey] value and
 *  compute warmPct via the sentiment lexicon. */
export function computeDailyKpis(
  rows: AgentCallRow[],
  sentimentKey?: string | null,
): DailyKpi[] {
  const byDay = new Map<string, DailyKpi>();
  for (const r of rows) {
    if (!r.started_at) continue;
    const day = etDay(r.started_at);
    let k = byDay.get(day);
    if (!k) {
      k = emptyDay(day);
      byDay.set(day, k);
    }
    k.callsMade++;
    const o = r.outcome ?? "";
    if (CONNECTED_OUTCOMES.has(o)) k.connected++;
    if ((r.duration_seconds ?? 0) > 60) k.convGt1min++;
    if (dmReached(r)) k.dms++;
    if (o === "callback") k.callbacks++;
    if (o === "call_back_later") k.callbackLater++;
    if (o === "goal_met") k.goals++;
    if (o === "not_interested") k.notInterested++;
    if (o === "gatekeeper") k.gatekeeper++;
    if (o === "hung_up_immediately") k.hungUp++;
    if (o === "ai_error") k.aiError++;
    if (o === "dnc") k.dnc++;
    if (sentimentKey) {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const v = String(ed[sentimentKey] ?? "")
        .trim()
        .toLowerCase();
      if (v) k.sentimentCounts[v] = (k.sentimentCounts[v] ?? 0) + 1;
    }
  }
  for (const k of byDay.values()) {
    const entries = Object.entries(k.sentimentCounts);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    const warm = entries.reduce((s, [v, n]) => s + (isWarm(v) ? n : 0), 0);
    k.warmPct = total === 0 ? 0 : warm / total;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}
```

Note `interestOf` stays exported (still used by `hasInterestData` / Hot Leads).

- [ ] **Step 3: Verify** — `npx eslint src/lib/agent-analytics/stats.ts` clean; tsc will flag `dashboard-view`/`report-data` interest references until later tasks.
- [ ] **Step 4: Commit**

```bash
git add src/lib/agent-analytics/stats.ts
git commit -m "feat(reporting): generalized per-campaign sentiment counts in KPIs"
```

---

## Task 3: Data layer — voice rows + dashboard sentiment key

**Files:** Modify `src/lib/agent-analytics/report-data.ts`

- [ ] **Step 1: Reshape `VoiceRow`**

```ts
export type VoiceRow = {
  id: string;
  day: string;
  company: string;
  list: string;
  leadId: string | null;
  /** The campaign's sentiment value, lowercased (e.g. "yes", "happy"). */
  sentiment: string;
  /** The campaign's free-text notes answer. */
  notes: string;
  /** Storage object path or legacy http(s) URL; null when no recording. */
  recordingPath: string | null;
};
```

- [ ] **Step 2: Add the `DetectedFields` import + rewrite `fetchVoiceRows`**

Add `import type { DetectedFields } from "./field-detect";`. Replace the whole `fetchVoiceRows` function:

```ts
export async function fetchVoiceRows(
  supabase: DB,
  scope: ReportScope,
  detected: DetectedFields,
): Promise<VoiceRow[]> {
  if (scope.kind !== "campaign" || !detected.sentimentKey) return [];
  const sentimentKey = detected.sentimentKey;
  const { data } = await supabase
    .from("calls")
    .select(
      "id, started_at, lead_id, extracted_data, recording_path, lead:leads(company, list:lists(name))",
    )
    .eq("campaign_id", scope.campaignId)
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .not(`extracted_data->>${sentimentKey}`, "is", null)
    .order("started_at", { ascending: false })
    .limit(2000);

  type Raw = {
    id: string;
    started_at: string | null;
    lead_id: string | null;
    extracted_data: unknown;
    recording_path: string | null;
    lead: unknown;
  };
  return ((data ?? []) as unknown as Raw[])
    .map((r): VoiceRow | null => {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const sentiment = String(ed[sentimentKey] ?? "")
        .trim()
        .toLowerCase();
      if (!sentiment) return null; // belt-and-suspenders vs the DB JSON filter
      const notes = detected.notesKey
        ? String(ed[detected.notesKey] ?? "").trim()
        : "";
      const { company, list } = leadCompany(r.lead);
      return {
        id: r.id,
        day: r.started_at ? etDay(r.started_at) : "",
        company,
        list,
        leadId: r.lead_id,
        sentiment,
        notes,
        recordingPath: r.recording_path,
      };
    })
    .filter((r): r is VoiceRow => r !== null);
}
```

Note: `interestOf` and `fmtLen` may become unused after Tasks 3–5. If eslint flags `fmtLen` as unused (Hot Leads still uses it — it does, in `fetchHotLeadRows`), leave it. `interestOf` is still imported for nothing here — remove `interestOf` from the `./stats` import in this file if eslint flags it unused (it's used by `hasInterestData`? check — `hasInterestData` uses a DB `.in(...)` filter, not `interestOf`; so `interestOf` import here is now unused → remove it from the import).

- [ ] **Step 3: Thread `sentimentKey` into `fetchDashboardKpis`**

Change the signature + the `computeDailyKpis` call:

```ts
export async function fetchDashboardKpis(
  supabase: DB,
  scope: DashboardKpiScope,
  sentimentKey?: string | null,
): Promise<DailyKpi[]> {
```

…and at the end, `return computeDailyKpis(rows, sentimentKey);` (instead of `computeDailyKpis(rows)`). Leave the pagination/`.or()` body unchanged.

- [ ] **Step 4: Verify** — `npx eslint src/lib/agent-analytics/report-data.ts` clean (remove any now-unused import it flags); tsc flags page/voice-table until later tasks.
- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-analytics/report-data.ts
git commit -m "feat(reporting): voice rows carry sentiment/notes/recording/lead; kpi sentimentKey"
```

---

## Task 4: Dashboard dynamic sentiment columns

**Files:** Modify `src/app/(app)/reporting/dashboard-view.tsx`

Phase 1 left this with a `showSentiment` boolean gating fixed Yes/Maybe/No/Warm% columns. Replace that with dynamic columns driven by `sentimentValues: string[]`.

- [ ] **Step 1: Swap the prop**

In the props type + destructure, replace `showSentiment = false` / `showSentiment?: boolean` with:

```tsx
  sentimentValues = [],
```

```tsx
  /** The selected campaign's sentiment values, in display order. Empty = no
   *  sentiment columns (combined view or a campaign without sentiment). */
  sentimentValues?: string[];
```

Add a derived `const showSentiment = sentimentValues.length > 0;` at the top of the component body (keeps the rest of the gating logic readable).

- [ ] **Step 2: Title-case helper + dynamic numeric headers**

Add near the top of the file (module scope):

```tsx
/** "lead source satisfaction" / "happy" → "Happy" for a column header. */
function titleCase(v: string): string {
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
```

Replace the `NUM_HEADERS` constant so the sentiment headers are the detected values:

```tsx
const NUM_HEADERS = [
  "Calls",
  "Conn.",
  ">1m",
  "DMs",
  "CB",
  "CB later",
  "Goals",
  "Not int.",
  "Gatekpr",
  "Hung up",
  "AI err",
  "DNC",
  ...sentimentValues.map(titleCase),
];
```

(The existing `i === NUM_HEADERS.length - 1 && !showSentiment && !showNotes` rounded-corner logic and the separate Warm% `<th>` gated on `showSentiment` from Phase 1 stay as-is — they already key off `showSentiment`, which is now derived.)

- [ ] **Step 3: Body cells — dynamic per-value counts**

Replace the Phase 1 `{showSentiment ? (<>…three interest <td> + warm <td>…</>) : null}` block with:

```tsx
{
  showSentiment ? (
    <>
      {sentimentValues.map((v) => (
        <td key={v} className="px-3 py-2 text-right tabular-nums">
          {k.sentimentCounts[v] ?? 0}
        </td>
      ))}
      <td className="px-3 py-2 text-right">{warmChip(k.warmPct)}</td>
    </>
  ) : null;
}
```

- [ ] **Step 4: Summary Warm% tile + CSV**

The Warm% summary tile (`{showSentiment ? <KpiTile label="Warm %" … /> : null}`) stays. For the summary tile value it uses `sel.warmPct` — unchanged.

Replace the CSV `exportRows` sentiment part and `headers` to use dynamic values:

```tsx
const exportRows = kpis.map((k) => [
  k.day,
  k.callsMade,
  k.connected,
  k.convGt1min,
  k.dms,
  k.callbacks,
  k.callbackLater,
  k.goals,
  k.notInterested,
  k.gatekeeper,
  k.hungUp,
  k.aiError,
  k.dnc,
  ...sentimentValues.map((v) => k.sentimentCounts[v] ?? 0),
  ...(showSentiment ? [pct(k.warmPct)] : []),
]);
```

```tsx
            headers={[
              "day",
              "calls_made",
              "connected",
              "conversations_gt1min",
              "dms_reached",
              "callbacks",
              "callback_later",
              "goals_met",
              "not_interested",
              "gatekeeper",
              "hung_up",
              "ai_error",
              "dnc",
              ...sentimentValues,
              ...(showSentiment ? ["warm_pct"] : []),
            ]}
```

Update `zeroDay`/any local empty-day helper in this file: if `dashboard-view.tsx` has its own `zeroDay` (it does — used for `sel`), replace the three `interest*: 0` lines with `sentimentCounts: {},` to match the new `DailyKpi`.

- [ ] **Step 5: Verify** — `npx eslint "src/app/(app)/reporting/dashboard-view.tsx"` clean; tsc clean for this file once `DailyKpi` (Task 2) is in.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/reporting/dashboard-view.tsx"
git commit -m "feat(reporting): dashboard renders each campaign's own sentiment columns"
```

---

## Task 5: Recording redirect routes

**Files:**

- Create `src/app/api/reporting/recording/[callId]/route.ts`
- Create `src/app/share/reporting/[token]/recording/[callId]/route.ts`

Both resolve a call's `recording_path` to a playable URL and 302-redirect. A legacy `http(s)` path is used directly; a storage object path is signed via `call-recordings`.

- [ ] **Step 1: Shared resolver — add to `src/lib/calls/actions.ts`? No — keep routes self-contained.** Write the admin route:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** Admin-only: resolve a call's recording to a playable URL and redirect.
 *  Used as the `<audio src>` in the Reporting Voice of Customer tab. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const { callId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin")
    return new NextResponse("Forbidden", { status: 403 });

  const { data: call } = await supabase
    .from("calls")
    .select("recording_path")
    .eq("id", callId)
    .maybeSingle();
  const path = call?.recording_path;
  if (!path) return new NextResponse("Not found", { status: 404 });
  if (/^https?:\/\//.test(path)) return NextResponse.redirect(path);
  const { data: signed } = await supabase.storage
    .from("call-recordings")
    .createSignedUrl(path, 3600);
  if (!signed?.signedUrl) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(signed.signedUrl);
}
```

- [ ] **Step 2: Write the public token-gated route** (`src/app/share/reporting/[token]/recording/[callId]/route.ts`):

```ts
import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** Public, token-gated: resolve a call's recording to a playable URL and
 *  redirect. The share token is validated against app_settings (same gate as
 *  the share page). Service-role client (key stays server-side). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string; callId: string }> },
) {
  const { token, callId } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return new NextResponse("Not found", { status: 404 });
  const supabase = createServiceClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: settings } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const expected = settings?.agent_analytics_share_token ?? "";
  if (!expected || token !== expected)
    return new NextResponse("Not found", { status: 404 });

  const { data: call } = await supabase
    .from("calls")
    .select("recording_path")
    .eq("id", callId)
    .maybeSingle();
  const path = call?.recording_path;
  if (!path) return new NextResponse("Not found", { status: 404 });
  if (/^https?:\/\//.test(path)) return NextResponse.redirect(path);
  const { data: signed } = await supabase.storage
    .from("call-recordings")
    .createSignedUrl(path, 3600);
  if (!signed?.signedUrl) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(signed.signedUrl);
}
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no errors in these files); `npx eslint` on both route files clean. Confirm `proxy.ts`/middleware already exempts `/share/*` (it does, per the share page) — the public route lives under `/share/` so it's reachable without auth.
- [ ] **Step 4: Commit**

```bash
git add "src/app/api/reporting/recording/[callId]/route.ts" "src/app/share/reporting/[token]/recording/[callId]/route.ts"
git commit -m "feat(reporting): recording redirect routes (admin + token-gated public)"
```

---

## Task 6: scope-picker gains `basePath`

**Files:** Modify `src/app/(app)/reporting/scope-picker.tsx`

- [ ] **Step 1: Add the prop + use it in navigation**

Add `basePath: string` to the props type + destructure. Change `onChange` to build the link from `basePath`:

```tsx
function onChange(next: string) {
  const params = new URLSearchParams(sp.toString());
  params.set("scope", next);
  router.push(`${basePath}?${params.toString()}`);
}
```

- [ ] **Step 2: Verify** — tsc will flag the existing `<ScopePicker>` call in page.tsx (missing `basePath`) until Task 8; `npx eslint "src/app/(app)/reporting/scope-picker.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/scope-picker.tsx"
git commit -m "feat(reporting): scope picker takes basePath (admin + share reuse)"
```

---

## Task 7: Per-tab visibility

**Files:** Modify `src/app/(app)/reporting/reporting-tabs.tsx`

- [ ] **Step 1: Replace `reportingTabsFor`**

```tsx
/** The tabs to show for the current scope. Voice of Customer shows when the
 *  campaign has a detected sentiment field; Hot Leads keeps its interest-driven
 *  gate (Phase 3 generalizes it). */
export function reportingTabsFor({
  showVoice,
  showHotLeads,
}: {
  showVoice: boolean;
  showHotLeads: boolean;
}): readonly (typeof REPORTING_TABS)[number][] {
  return REPORTING_TABS.filter((t) => {
    if (t.key === "voice") return showVoice;
    if (t.key === "hot-leads") return showHotLeads;
    return true;
  });
}
```

Remove the now-unused `INTEREST_COMBINED_NOTE` export if nothing imports it after Task 8/9 (the combined view no longer shows the interest tabs, so the note is dropped). If other files still import it at this point, leave it and remove in Task 8/9 when those imports go.

- [ ] **Step 2: Verify** — tsc flags the `reportingTabsFor(showInterest)` call sites (page + share) until Tasks 8–9; eslint clean for this file.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/reporting-tabs.tsx"
git commit -m "feat(reporting): per-tab visibility (voice vs hot-leads)"
```

---

## Task 8: Rewrite the Voice of Customer table

**Files:** Rewrite `src/app/(app)/reporting/voice-table.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
"use client";

import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import Link from "next/link";

import { Input } from "@/components/ui/input";
import { sentimentTone } from "@/lib/agent-analytics/field-detect";
import type { VoiceRow } from "@/lib/agent-analytics/report-data";

import { ExportCsvButton } from "./export-csv-button";

export type { VoiceRow };

/** "yes" → "Yes", "lead source" stays per-word capitalized. */
function titleCase(v: string): string {
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Voice of Customer — one row per call that recorded the campaign's sentiment
 *  answer (last 30d), with the free-text notes, the lead, and an inline
 *  recording player. `readOnly` (public share) makes the company plain text.
 *  `recordingSrcFor` builds the `<audio src>` URL for a call id. */
export function VoiceTable({
  rows,
  sentimentValues,
  recordingSrcFor,
  readOnly = false,
  scopeSlug = "all-campaigns",
}: {
  rows: VoiceRow[];
  sentimentValues: string[];
  recordingSrcFor: (callId: string) => string;
  readOnly?: boolean;
  scopeSlug?: string;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.sentiment !== filter) return false;
      if (!needle) return true;
      return (
        r.company.toLowerCase().includes(needle) ||
        r.notes.toLowerCase().includes(needle) ||
        r.list.toLowerCase().includes(needle)
      );
    });
  }, [rows, filter, q]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.sentiment] = (m[r.sentiment] ?? 0) + 1;
    return m;
  }, [rows]);

  const exportRows = filtered.map((r) => [
    r.day,
    r.company,
    r.list,
    r.sentiment,
    r.notes,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Every call with a customer-sentiment answer (last 30 days), with the
        agent&apos;s recorded notes and the call recording.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          label="All"
          active={filter === "all"}
          onClick={() => setFilter("all")}
          count={rows.length}
        />
        {sentimentValues.map((v) => (
          <FilterPill
            key={v}
            label={titleCase(v)}
            active={filter === v}
            onClick={() => setFilter(v)}
            count={counts[v] ?? 0}
          />
        ))}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, notes, list…"
          className="ml-auto h-8 w-[16rem]"
        />
        <ExportCsvButton
          filename={`${scopeSlug}-voice-of-customer.csv`}
          headers={["day", "company", "list", "sentiment", "notes"]}
          rows={exportRows}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          No matching calls.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-muted/30 text-left text-[10px] tracking-wide uppercase">
                <th className="rounded-l-md px-3 py-2 font-medium whitespace-nowrap">
                  Day
                </th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  List
                </th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  Sentiment
                </th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="rounded-r-md px-3 py-2 font-medium whitespace-nowrap">
                  Recording
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-border/60 hover:bg-muted/30 border-b align-top transition-colors"
                >
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.day}
                  </td>
                  <td className="text-foreground px-3 py-2 font-medium">
                    {!readOnly && r.leadId ? (
                      <Link
                        href={`/leads/${r.leadId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {r.company || "—"}
                      </Link>
                    ) : (
                      r.company || "—"
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {r.list || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${sentimentTone(r.sentiment)}`}
                    >
                      {titleCase(r.sentiment)}
                    </span>
                  </td>
                  <td className="text-muted-foreground px-3 py-2">
                    {r.notes || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.recordingPath ? (
                      playing === r.id ? (
                        <audio
                          controls
                          autoPlay
                          preload="none"
                          src={recordingSrcFor(r.id)}
                          className="h-8 w-[14rem]"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPlaying(r.id)}
                          className="text-primary inline-flex items-center gap-1 hover:underline"
                        >
                          <Play className="size-3.5" /> Play
                        </button>
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-foreground text-background"
          : "bg-muted text-muted-foreground hover:text-foreground")
      }
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for this file; `npx eslint "src/app/(app)/reporting/voice-table.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/reporting/voice-table.tsx"
git commit -m "feat(reporting): voice of customer = sentiment + notes + recording + lead link"
```

---

## Task 9: Wire the admin page

**Files:** Modify `src/app/(app)/reporting/page.tsx`

- [ ] **Step 1: Imports**

Add `import { detectCampaignFields, type DetectedFields } from "@/lib/agent-analytics/field-detect";`. Remove the `INTEREST_COMBINED_NOTE` import (no longer used). Keep `hasInterestData`.

- [ ] **Step 2: Detection + gates**

Replace the Phase 1 `showInterest` / `showSentiment` / `visibleTabs` / `kpiScope` block with:

```tsx
const detected: DetectedFields =
  scope.kind === "campaign"
    ? await detectCampaignFields(supabase, scope.campaignId)
    : { sentimentKey: null, sentimentValues: [], notesKey: null };
const showVoice = scope.kind === "campaign" && detected.sentimentKey !== null;
const showHotLeads =
  scope.kind === "campaign" && (await hasInterestData(supabase, scope));
const visibleTabs = reportingTabsFor({ showVoice, showHotLeads });
const tab = visibleTabs.some((t) => t.key === str(params.tab))
  ? str(params.tab)
  : "dashboard";

const kpiScope: DashboardKpiScope =
  scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };
```

- [ ] **Step 3: Picker basePath + tab content props**

Add `basePath="/reporting"` to `<ScopePicker .../>`. In the dashboard branch, change `<DashboardTab .../>` to pass `sentimentKey={detected.sentimentKey}` and `sentimentValues={detected.sentimentValues}` (replacing `showSentiment`). In the voice branch, change to `<VoiceTab scope={scope} detected={detected} slug={slug} />`.

- [ ] **Step 4: Update the tab helper components**

`DashboardTab`:

```tsx
async function DashboardTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
  sentimentKey,
  sentimentValues,
}: {
  kpiScope: DashboardKpiScope;
  selectedDay: string;
  scopeParam: string;
  slug: string;
  sentimentKey: string | null;
  sentimentValues: string[];
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, kpiScope, sentimentKey);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  const { data: noteRows } = await supabase
    .from("dashboard_notes")
    .select("day, note");
  const notes: Record<string, string> = {};
  for (const r of noteRows ?? []) notes[r.day] = r.note;
  return (
    <DashboardView
      kpis={kpis}
      day={day}
      historyDays={DASHBOARD_DAYS}
      dayHrefFor={(d) =>
        `/reporting?tab=dashboard&scope=${scopeParam}&day=${d}`
      }
      notes={notes}
      notesEditable
      scopeSlug={slug}
      sentimentValues={sentimentValues}
    />
  );
}
```

`VoiceTab`:

```tsx
async function VoiceTab({
  scope,
  detected,
  slug,
}: {
  scope: ReportScope;
  detected: DetectedFields;
  slug: string;
}) {
  const supabase = await createClient();
  return (
    <VoiceTable
      rows={await fetchVoiceRows(supabase, scope, detected)}
      sentimentValues={detected.sentimentValues}
      recordingSrcFor={(id) => `/api/reporting/recording/${id}`}
      scopeSlug={slug}
    />
  );
}
```

(`HotLeadsTab` stays exactly as in Phase 1 — unchanged. Drop the `note` param/usage it received in the prior follow-up since `INTEREST_COMBINED_NOTE` is gone; pass nothing.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit` (share page still errors until Task 10). `npx eslint "src/app/(app)/reporting/page.tsx"` clean.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/reporting/page.tsx"
git commit -m "feat(reporting): admin page detection wiring + dynamic sentiment/voice"
```

---

## Task 10: Make the public share scope-aware

**Files:** Modify `src/app/share/reporting/[token]/page.tsx`

- [ ] **Step 1: Imports + campaigns + scope**

Add imports: `detectCampaignFields`, `type DetectedFields` from field-detect; `parseScopeParam, serializeScope, type ReportScope` from scope; `ScopePicker` from the reporting dir. Remove `INTEREST_COMBINED_NOTE`. After token validation, load campaigns and parse/validate scope (mirroring the admin page):

```tsx
const { data: campaignRows } = await supabase
  .from("campaigns")
  .select("id, name")
  .order("name");
const campaigns = (campaignRows ?? []) as { id: string; name: string }[];

let scope = parseScopeParam(str(sp.scope));
if (
  scope.kind === "campaign" &&
  !campaigns.some((c) => c.id === scope.campaignId)
) {
  scope = { kind: "all" };
}
const scopeParam = serializeScope(scope);

const detected: DetectedFields =
  scope.kind === "campaign"
    ? await detectCampaignFields(supabase, scope.campaignId)
    : { sentimentKey: null, sentimentValues: [], notesKey: null };
const showVoice = scope.kind === "campaign" && detected.sentimentKey !== null;
const showHotLeads =
  scope.kind === "campaign" && (await hasInterestData(supabase, scope));
const visibleTabs = reportingTabsFor({ showVoice, showHotLeads });
const tab = visibleTabs.some((t) => t.key === str(sp.tab))
  ? str(sp.tab)
  : "dashboard";

const kpiScope =
  scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };
```

- [ ] **Step 2: Header picker + scoped content**

Add `<ScopePicker campaigns={campaigns} value={scopeParam} basePath={`/share/reporting/${token}`} />` in the header. Pass `tabs={visibleTabs}` to `<ReportingTabs>` and make `hrefFor` carry the scope: `` `/share/reporting/${token}?tab=${k}&scope=${scopeParam}` ``. Update each tab branch:

- **dashboard:** `kpis={await fetchDashboardKpis(supabase, kpiScope, detected.sentimentKey)}`, `sentimentValues={detected.sentimentValues}` (drop `showSentiment`), keep `notes`/`notesEditable`, `scopeSlug={scope.kind === "campaign" ? "campaign" : "all-campaigns"}`.
- **voice:** `<VoiceTable rows={await fetchVoiceRows(supabase, scope, detected)} sentimentValues={detected.sentimentValues} recordingSrcFor={(id) => `/share/reporting/${token}/recording/${id}`} readOnly scopeSlug="campaign" />`.
- **hot-leads / changelog / prompt-log:** unchanged (read-only); drop the `note={INTEREST_COMBINED_NOTE}` props.

The dashboard-notes lookup block guarded by `if (tab === "dashboard" && (agent || campaignIds.length))` from before — simplify its guard to `if (tab === "dashboard")` (campaigns always exist now).

- [ ] **Step 3: Verify (full)**
  - `npx tsc --noEmit` → only the 3 pre-existing `twilio-*.spec.ts` errors.
  - `npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics` → clean.
  - `npm run build` → success.
- [ ] **Step 4: Commit**

```bash
git add "src/app/share/reporting/[token]/page.tsx"
git commit -m "feat(reporting): public share is scope-aware with read-only picker + recordings"
```

---

## Task 11: Playwright contract

**Files:** Modify `tests/reporting-scope.spec.ts`

- [ ] **Step 1: Extend the spec**

Seed (service-role, `E2E_TEST_EMAIL` owner): an agent, a goal, a campaign, a lead, and 3 outbound calls on the campaign whose `extracted_data` carries a custom categorical field (`{ ai_call_answering_interest: "yes" | "maybe" | "no" }`) + a long-text field (`ai_call_answering_reason`) + a `recording_path` (e.g. `"https://example.com/rec.mp3"` so the redirect uses the http branch), plus a second campaign whose calls carry only `{}`. Assert:

- `/reporting?scope=campaign:<sentiment campaign>&tab=dashboard` → a column header "Yes" exists (dynamic sentiment column).
- `/reporting?scope=campaign:<sentiment campaign>&tab=voice` → the Voice tab renders; a "Play" control and a "Sentiment" header are present; the company cell is a link to `/leads/<id>`.
- `/reporting?scope=campaign:<no-sentiment campaign>` → no "Voice of Customer" tab link; dashboard has no "Yes" column.
- `/reporting?scope=all` → no "Voice of Customer" tab; no sentiment columns.
- `GET /api/reporting/recording/<seeded callId>` (authenticated context via the page's request fixture) returns a redirect/200 (status < 400), and an unknown id returns 404.

Use `page.getByRole("columnheader", { name: "Yes" })`, `page.getByRole("link", { name: "Voice of Customer" })`, `page.getByRole("button", { name: /play/i })`, and `page.getByRole("link")` filtered by `/leads/`. Follow the existing file's seeding/cleanup shape.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for the spec; `npx eslint tests/reporting-scope.spec.ts` clean. (Do not run Playwright.)
- [ ] **Step 3: Commit**

```bash
git add tests/reporting-scope.spec.ts
git commit -m "test(reporting): generalized sentiment + voice + recording route"
```

---

## Task 12: Final verification + PR

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit      # only the 3 pre-existing twilio-*.spec.ts errors
npx eslint "src/app/(app)/reporting" "src/app/share/reporting" src/lib/agent-analytics "src/app/api/reporting"
npm run build
```

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/reporting-phase2-voice-generalized
gh pr create --base main --head feat/reporting-phase2-voice-generalized \
  --title "feat(reporting): Phase 2 — generalized sentiment, Voice of Customer, recordings" \
  --body "Phase 2 of the reporting redesign. Each campaign's own sentiment + notes fields are auto-detected and drive the Dashboard sentiment columns and the Voice of Customer tab (sentiment pill + notes + inline recording playback + clickable lead names on admin). Public share is scope-aware with a read-only campaign picker; recordings play via token-gated redirect. Hot Leads unchanged (Phase 3). No DB migration. Spec: docs/superpowers/specs/2026-06-26-reporting-redesign-phase2-design.md."
```

- [ ] **Step 3: Confirm with Marija before merging** (production-facing; merge auto-deploys).

---

## Self-review notes

- **Spec coverage:** detection (T1) ✓; dashboard generalized columns (T2 stats, T3 fetch, T4 view, T9 wire) ✓; Voice of Customer generalized + pill + notes + recording + lead link (T3, T8, T9) ✓; recordings admin+public routes (T5) ✓; combined hides sentiment/voice (T4 `sentimentValues=[]`, T7 gating, T9/T10) ✓; share scope-aware + read-only picker (T6 basePath, T10) ✓; Hot Leads unchanged/MR-gated (T7 `showHotLeads`) ✓; no migration ✓.
- **Type consistency:** `DetectedFields {sentimentKey, sentimentValues, notesKey}` used by detect/report-data/page/share. `DailyKpi.sentimentCounts` set in stats, read in dashboard-view. `VoiceRow {…sentiment, notes, leadId, recordingPath}` produced by fetchVoiceRows, consumed by VoiceTable. `fetchDashboardKpis(scope, sentimentKey?)`, `fetchVoiceRows(scope, detected)`, `reportingTabsFor({showVoice, showHotLeads})`, `ScopePicker basePath`, `recordingSrcFor` — all match call sites. `sentimentTone`/`isWarm`/`sentimentRank` exported from field-detect, used by stats (isWarm) + voice-table (sentimentTone).
- **Placeholder scan:** none — concrete code throughout.
- **Watch:** `interestOf` import in report-data becomes unused (remove if flagged); `INTEREST_COMBINED_NOTE` export removed once page+share stop importing it (T9/T10); `zeroDay`/`emptyDay` both updated to `sentimentCounts: {}`.
