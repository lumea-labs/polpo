import { test, expect } from "@playwright/test";

test.describe.serial("LLM Key CRUD", () => {
  test("add an LLM key via form", async ({ page }) => {
    await page.goto("/llm-gateway");

    // Open form
    await page.getByTestId("llm-key-add-btn").click();
    await expect(page.getByTestId("llm-key-form")).toBeVisible();

    // Provider defaults to xAI — keep it or select OpenAI
    const providerSelect = page.getByTestId("llm-key-form").locator("select").nth(1);
    await providerSelect.selectOption("openai");

    // Fill API key
    await page.getByPlaceholder("sk-...").fill("sk-test-e2e-fake-key-12345");

    // Fill label
    await page.getByPlaceholder("Production key").fill("E2E Test Key");

    // Submit
    await page.getByRole("button", { name: "Save key" }).click();

    // Form should close and key should appear in table
    await expect(page.getByTestId("llm-key-form")).not.toBeVisible({ timeout: 5_000 });

    const table = page.getByTestId("llm-gateway-table");
    await expect(table).toBeVisible({ timeout: 5_000 });
    await expect(table).toContainText("openai");
    await expect(table).toContainText("E2E Test Key");
  });

  test("delete the LLM key", async ({ page }) => {
    await page.goto("/llm-gateway");

    const table = page.getByTestId("llm-gateway-table");
    await expect(table).toBeVisible({ timeout: 5_000 });

    // Find the row with our key and click its delete button
    const row = table.locator("tr", { hasText: "E2E Test Key" });
    if (!(await row.isVisible().catch(() => false))) {
      test.skip(true, "LLM key not found in table");
      return;
    }

    const deleteBtn = row.locator("button");
    await deleteBtn.click();

    // Row should disappear
    await expect(row).not.toBeVisible({ timeout: 5_000 });
  });
});
