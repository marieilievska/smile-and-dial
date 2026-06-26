import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Reporting scope filter:
 *  - The scope picker is present; default view is All agents.
 *  - An agent WITH interest data shows the Voice of Customer + Hot Leads tabs.
 *  - An agent WITHOUT interest data hides those tabs (Dashboard only).
 */
test.describe("Reporting scope filter", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let interestAgentId: string;
  let plainAgentId: string;
  let goalId: string;
  let leadId: string;
  const callIds: string[] = [];

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

    const mk = async (name: string) => {
      const { data } = await admin
        .from("agents")
        .insert({
          owner_id: ownerId,
          name,
          prompt_personality: "x",
          prompt_environment: "x",
          prompt_tone: "x",
          prompt_goal: "x",
          prompt_guardrails: "x",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    interestAgentId = await mk(`E2E Scope Interest ${stamp}`);
    plainAgentId = await mk(`E2E Scope Plain ${stamp}`);

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Scope Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Scope Co ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    const insertCall = async (
      agentId: string,
      extracted: Record<string, unknown> | null,
    ) => {
      const { data } = await admin
        .from("calls")
        .insert({
          lead_id: leadId,
          agent_id: agentId,
          goal_id: goalId,
          direction: "outbound",
          status: "completed",
          outcome: "completed",
          duration_seconds: 80,
          started_at: new Date().toISOString(),
          extracted_data: extracted,
        })
        .select("id")
        .single();
      callIds.push(data!.id);
    };
    await insertCall(interestAgentId, { ai_call_answering_interest: "yes" });
    await insertCall(plainAgentId, { some_other_field: "value" });
  });

  test.afterAll(async () => {
    for (const id of callIds) await admin.from("calls").delete().eq("id", id);
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", interestAgentId ?? "");
    await admin
      .from("agents")
      .delete()
      .eq("id", plainAgentId ?? "");
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
  });

  test("default view shows the picker and the interest tabs", async ({
    page,
  }) => {
    await page.goto("/reporting");
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
  });

  test("an agent without interest data hides the interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=agent:${plainAgentId}`);
    await expect(page.locator("#reporting-scope")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Hot Leads" })).toHaveCount(0);
    // Dashboard is still there.
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  });

  test("an agent with interest data shows the interest tabs", async ({
    page,
  }) => {
    await page.goto(`/reporting?scope=agent:${interestAgentId}`);
    await expect(
      page.getByRole("link", { name: "Voice of Customer" }),
    ).toBeVisible();
  });
});
