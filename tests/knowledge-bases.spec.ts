import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe("knowledge bases", () => {
  // Remove knowledge bases left behind by an earlier interrupted run.
  test.beforeAll(async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("knowledge_bases").delete().like("name", "E2E KB %");
  });

  test("create a knowledge base, add sources, and delete it", async ({
    page,
  }) => {
    const stamp = Date.now();
    const name = `E2E KB ${stamp}`;
    const url = `https://example.com/e2e-${stamp}`;
    const fileName = `e2e-doc-${stamp}.txt`;

    await page.goto("/settings/knowledge-bases");

    // Create the knowledge base.
    await page.getByRole("button", { name: "New knowledge base" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create knowledge base" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();

    // Open its sources dialog.
    await page
      .getByRole("row", { name })
      .getByRole("button", { name: "Sources" })
      .click();
    const dialog = page.getByRole("dialog");

    // Add a URL source.
    await dialog.getByLabel("Add a URL").fill(url);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByText(url)).toBeVisible();

    // Upload a file source.
    await dialog.getByLabel("Upload a file").setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("E2E knowledge base content."),
    });
    await expect(dialog.getByText(fileName)).toBeVisible();

    // Remove the URL source.
    await dialog.getByRole("button", { name: `Remove ${url}` }).click();
    await expect(dialog.getByText(url)).toHaveCount(0);

    // Close the dialog and delete the knowledge base.
    await page.keyboard.press("Escape");
    await page
      .getByRole("row", { name })
      .getByRole("button", { name: `Delete ${name}` })
      .click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toHaveCount(0);
  });
});
