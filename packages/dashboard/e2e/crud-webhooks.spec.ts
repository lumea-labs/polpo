import { test, expect } from "@playwright/test";

const WEBHOOK_URL = `https://e2e-test.example.com/hook-${Date.now()}`;

/**
 * Navigate to the webhooks tab of the first available project.
 */
async function goToWebhooks(page: import("@playwright/test").Page) {
  await page.goto("/projects");
  const firstCard = page.locator("[data-testid^='project-card-']").first();
  if (!(await firstCard.isVisible().catch(() => false))) {
    test.skip(true, "No projects");
    return;
  }
  await firstCard.click();
  await page.waitForURL(/\/projects\/[^/]+/);
  await page.getByTestId("nav-webhooks").click();
  await page.waitForURL(/\/webhooks/);
}

test.describe.serial("Webhook CRUD", () => {
  test("add a webhook via form", async ({ page }) => {
    await goToWebhooks(page);

    // Click add
    const addBtn = page.getByTestId("webhook-add-btn");
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    // Form should appear
    await expect(page.getByTestId("webhook-form")).toBeVisible();

    // Fill URL
    await page.getByPlaceholder("https://example.com/webhook").fill(WEBHOOK_URL);

    // Events defaults to "All events" — keep it
    // Submit
    await page.getByRole("button", { name: "Create" }).click();

    // Form should close, webhook should appear in list
    await expect(page.getByTestId("webhook-form")).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("webhooks-list")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("webhooks-list")).toContainText(WEBHOOK_URL);
  });

  test("webhook shows event badges", async ({ page }) => {
    await goToWebhooks(page);

    const list = page.getByTestId("webhooks-list");
    await expect(list).toBeVisible({ timeout: 10_000 });

    // The webhook we created has "All events" = "*"
    await expect(list).toContainText("*");
  });

  test("delete the webhook", async ({ page }) => {
    await goToWebhooks(page);

    const list = page.getByTestId("webhooks-list");
    await expect(list).toBeVisible({ timeout: 10_000 });

    // Find delete button for our webhook
    const webhookRow = list.locator("div", { hasText: WEBHOOK_URL }).first();
    const deleteBtn = webhookRow.locator("[data-testid^='webhook-delete-']");
    await deleteBtn.click();

    // Webhook should disappear
    await expect(page.getByText(WEBHOOK_URL)).not.toBeVisible({ timeout: 5_000 });
  });
});
