import { test, expect } from "@playwright/test";

/**
 * Helper: navigate to the first available project.
 * Skips the test if no projects exist.
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

test.describe("Project overview", () => {
  test("shows stat cards and activity section", async ({ page }) => {
    await goToFirstProject(page);

    // Wait for skeleton to resolve
    const stats = page.getByTestId("overview-stats");
    await expect(stats).toBeVisible({ timeout: 10_000 });

    // Should have 4 stat cards
    const cards = stats.locator("> div");
    await expect(cards).toHaveCount(4);

    // Activity section exists (list or empty)
    const activityList = page.getByTestId("activity-list");
    const activityEmpty = page.getByTestId("activity-empty");
    const hasActivity = await activityList.isVisible().catch(() => false);
    const hasEmpty = await activityEmpty.isVisible().catch(() => false);
    expect(hasActivity || hasEmpty).toBe(true);
  });
});

test.describe("Agents tab", () => {
  test("shows agents table or empty state", async ({ page }) => {
    await goToFirstProject(page);

    await page.getByTestId("nav-agents").click();
    await page.waitForURL(/\/agents/);

    // Wait for loading to finish
    const table = page.getByTestId("agents-table");
    const empty = page.getByTestId("agents-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("agent row navigates to profile", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-agents").click();
    await page.waitForURL(/\/agents/);

    const firstRow = page.locator("[data-testid^='agent-row-']").first();
    if (!(await firstRow.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstRow.click();
    await expect(page).toHaveURL(/\/agents\/[^/]+/);
  });
});

test.describe("Tasks tab", () => {
  test("shows tasks table or empty state", async ({ page }) => {
    await goToFirstProject(page);

    await page.getByTestId("nav-tasks").click();
    await page.waitForURL(/\/tasks/);

    const table = page.getByTestId("tasks-table");
    const empty = page.getByTestId("tasks-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("task row navigates to detail", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-tasks").click();
    await page.waitForURL(/\/tasks/);

    const firstRow = page.locator("[data-testid^='task-row-']").first();
    if (!(await firstRow.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstRow.click();
    await expect(page).toHaveURL(/\/tasks\/[^/]+/);
  });
});

test.describe("Sessions tab", () => {
  test("shows sessions list or empty state", async ({ page }) => {
    await goToFirstProject(page);

    await page.getByTestId("nav-sessions").click();
    await page.waitForURL(/\/sessions/);

    const list = page.getByTestId("sessions-list");
    const empty = page.getByTestId("sessions-empty");
    await expect(list.or(empty)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Missions tab", () => {
  test("shows missions table or empty state", async ({ page }) => {
    await goToFirstProject(page);

    await page.getByTestId("nav-missions").click();
    await page.waitForURL(/\/missions/);

    const table = page.getByTestId("missions-table");
    const empty = page.getByTestId("missions-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Other project tabs", () => {
  test("skills tab loads", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-skills").click();
    await page.waitForURL(/\/skills/);

    const table = page.getByTestId("skills-table");
    const empty = page.getByTestId("skills-empty");
    await expect(table.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("logs tab loads", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-logs").click();
    await page.waitForURL(/\/logs/);

    const sessions = page.getByTestId("logs-sessions");
    await expect(sessions).toBeVisible({ timeout: 10_000 });
  });

  test("webhooks tab loads", async ({ page }) => {
    await goToFirstProject(page);
    await page.getByTestId("nav-webhooks").click();
    await page.waitForURL(/\/webhooks/);

    const list = page.getByTestId("webhooks-list");
    const empty = page.getByTestId("webhooks-empty");
    const addBtn = page.getByTestId("webhook-add-btn");
    // Either has webhooks or empty + add button
    await expect(list.or(empty).or(addBtn)).toBeVisible({ timeout: 10_000 });
  });
});
