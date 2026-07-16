import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

/**
 * Prompt improvement suggestions (Reporting → Call review):
 *  - A bucket with a human-approved (curated) example shows "Suggest prompt
 *    fix (1)".
 *  - A seeded proposed suggestion renders in "Prompt improvements" with its
 *    rationale, an editable new-text box, and Approve/Dismiss.
 *  - Dismiss marks the suggestion dismissed (DB-checked) and clears it from
 *    "awaiting review".
 *  Generate/Approve are NOT exercised e2e (real OpenAI/ElevenLabs cost) — the
 *  edit engine and drafting are unit-tested in tests/prompt-suggest.unit.test.ts.
 */
test.describe("Prompt suggestions", () => {
  const stamp = Date.now();
  const FLAG_KEY = `e2e_sugg_${stamp}`;
  const FLAG_LABEL = `E2E Suggest ${stamp}`;
  const AGENT_PROMPT = `You are the E2E suggestion agent ${stamp}.\nAlways be brief.`;
  let admin: SupabaseClient;
  let ownerId: string;
  let agentId: string;
  let listId: string;
  let leadId: string;
  let callId: string;
  let suggestionId: string;

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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Suggest Agent ${stamp}`,
        system_prompt: AGENT_PROMPT,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Suggest List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Suggest Co ${stamp}`,
        business_phone: `+1556${String(stamp).slice(-7)}`,
        status: "ready_to_call",
        list_id: listId,
      })
      .select("id")
      .single();
    leadId = lead!.id as string;

    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        agent_id: agentId,
        direction: "outbound",
        status: "completed",
        outcome: "completed",
        duration_seconds: 60,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    callId = call!.id as string;

    // An active rubric def + a review row + a HUMAN-approved flag on the call.
    await admin.from("review_flag_defs").insert({
      key: FLAG_KEY,
      label: FLAG_LABEL,
      lens: "quality",
      severity: 2,
      guidance: "E2E: the agent made the seeded mistake.",
      active: true,
      is_candidate: false,
    });
    await admin.from("call_reviews").insert({
      call_id: callId,
      status: "done",
      reached_human: true,
    });
    await admin.from("call_review_flags").insert({
      call_id: callId,
      flag_key: FLAG_KEY,
      evidence_quote: "e2e example quote",
      confidence: 0.9,
      status: "confirmed",
      curated_by: ownerId,
      curated_at: new Date().toISOString(),
    });

    // A seeded proposed suggestion (as if Generate had run).
    const { data: sugg } = await admin
      .from("review_prompt_suggestions")
      .insert({
        agent_id: agentId,
        flag_key: FLAG_KEY,
        based_on_prompt: AGENT_PROMPT,
        proposed_prompt: `${AGENT_PROMPT}\n\nE2E RULE ${stamp}: never repeat the mistake.`,
        edits: [
          {
            type: "append",
            anchor: "",
            text: `E2E RULE ${stamp}: never repeat the mistake.`,
          },
        ],
        rationale: `E2E rationale ${stamp}: the examples show a recurring mistake.`,
        summary: `E2E summary ${stamp}`,
        example_count: 1,
      })
      .select("id")
      .single();
    suggestionId = sugg!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("call_review_flags").delete().eq("flag_key", FLAG_KEY);
    await admin
      .from("review_prompt_suggestions")
      .delete()
      .eq("flag_key", FLAG_KEY);
    await admin.from("call_reviews").delete().eq("call_id", callId);
    await admin.from("calls").delete().eq("id", callId);
    await admin.from("review_flag_defs").delete().eq("key", FLAG_KEY);
    await admin.from("leads").delete().eq("id", leadId);
    await admin.from("lists").delete().eq("id", listId);
    await admin.from("agents").delete().eq("id", agentId);
  });

  test("bucket with an approved example offers Suggest prompt fix", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    // The seeded bucket (unique label) is on the page, and its row carries the
    // suggest button with the available-example count.
    await expect(page.getByText(FLAG_LABEL).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Suggest prompt fix (1)" }).first(),
    ).toBeVisible();
  });

  test("a proposed suggestion renders diff, rationale, and editable text", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    await expect(
      page.getByText(`E2E rationale ${stamp}`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Awaiting your review").first()).toBeVisible();
    // The new text is editable before approval, prefilled from the edit.
    await expect(page.locator("textarea").first()).toHaveValue(
      new RegExp(`E2E RULE ${stamp}`),
    );
    await expect(
      page.getByRole("button", { name: "Approve & apply" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  test("dismiss archives the suggestion", async ({ page }) => {
    await signIn(page);
    await page.goto("/reporting?tab=call-review");
    await page.getByRole("button", { name: "Dismiss" }).first().click();
    await expect(page.getByText("Dismissed —", { exact: false })).toBeVisible();
    // DB-level assertion: the row is dismissed.
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("review_prompt_suggestions")
          .select("status")
          .eq("id", suggestionId)
          .single();
        return data?.status;
      })
      .toBe("dismissed");
  });
});
