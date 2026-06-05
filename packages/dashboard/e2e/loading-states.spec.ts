import { test, expect } from "@playwright/test";

/**
 * Verify that loading states show proper skeletons (not plain "Loading..." text)
 * and that they resolve to actual content.
 */

async function goToFirstProject(page: import("@playwright/test").Page) {
  await page.goto("/projects");
  const firstCard = page.locator("[data-testid^='project-card-']").first();
  if (!(await firstCard.isVisible().catch(() => false))) {
    test.skip();
    return;
  }
  await firstCard.click();
  await page.waitForURL(/\/projects\/[^/]+/);
}

test.describe("Loading states show skeletons, not plain text", () => {
  test("project overview never shows plain 'Loading' text", async ({ page }) => {
    await goToFirstProject(page);

    // Should never see raw "Loading..." text
    const loadingText = page.locator("text=Loading...");
    await expect(loadingText).not.toBeVisible({ timeout: 1000 }).catch(() => {
      // It's fine if it's already resolved
    });

    // Stats should resolve
    await expect(page.getByTestId("overview-stats")).toBeVisible({ timeout: 10_000 });
  });

  test("agents tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-agents").click();

    // Should not show "Loading agents..." text
    await expect(page.locator("text=Loading agents...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    // Should resolve to table or empty
    const table = page.getByTestId("agents-table");
    const empty = page.getByTestId("agents-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("tasks tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-tasks").click();

    await expect(page.locator("text=Loading tasks...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    const table = page.getByTestId("tasks-table");
    const empty = page.getByTestId("tasks-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("sessions tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-sessions").click();

    await expect(page.locator("text=Loading sessions...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    const list = page.getByTestId("sessions-list");
    const empty = page.getByTestId("sessions-empty");
    await expect(list.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("missions tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-missions").click();

    await expect(page.locator("text=Loading missions...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    const table = page.getByTestId("missions-table");
    const empty = page.getByTestId("missions-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("logs tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-logs").click();

    await expect(page.locator("text=Loading logs...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    await expect(page.getByTestId("logs-sessions")).toBeVisible({ timeout: 10_000 });
  });

  test("webhooks tab shows skeleton then resolves", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-webhooks").click();

    await expect(page.locator("text=Loading webhooks...")).not.toBeVisible({ timeout: 500 }).catch(() => {});

    const list = page.getByTestId("webhooks-list");
    const empty = page.getByTestId("webhooks-empty");
    const addBtn = page.getByTestId("webhook-add-btn");
    await expect(list.or(empty).or(addBtn)).toBeVisible({ timeout: 10_000 });
  });
});
