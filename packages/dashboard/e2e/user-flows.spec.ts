import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_USER_EMAIL ?? "e2e@polpo.dev";

test.describe("Account & Settings", () => {
  test("account page shows the logged-in user email", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByTestId("account-page")).toBeVisible();

    // Email should be visible in the profile table
    await expect(page.getByTestId("account-page")).toContainText(EMAIL);
  });

  test("settings page shows organization info", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();

    // Org name input should have a value (not empty)
    const orgInput = page.getByTestId("settings-page").locator("input").first();
    const value = await orgInput.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test("settings page shows email in account section", async ({ page }) => {
    await page.goto("/settings");

    // The email input should contain our email
    const emailInput = page.locator("input[type='email']");
    await expect(emailInput).toHaveValue(EMAIL);
  });
});

test.describe("Full project navigation flow", () => {
  test("navigate through all project tabs without errors", async ({ page }) => {
    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();
    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip(true, "No projects");
      return;
    }

    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/);

    // Overview — should show stats
    await expect(page.getByTestId("overview-stats")).toBeVisible({ timeout: 10_000 });

    // Agents
    await page.getByTestId("nav-agents").click();
    await expect(page.getByTestId("agents-table").or(page.getByTestId("agents-empty"))).toBeVisible({ timeout: 10_000 });

    // Sessions
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByTestId("sessions-list").or(page.getByTestId("sessions-empty"))).toBeVisible({ timeout: 10_000 });

    // Tasks
    await page.getByTestId("nav-tasks").click();
    await expect(page.getByTestId("tasks-table").or(page.getByTestId("tasks-empty"))).toBeVisible({ timeout: 10_000 });

    // Missions
    await page.getByTestId("nav-missions").click();
    await expect(page.getByTestId("missions-table").or(page.getByTestId("missions-empty"))).toBeVisible({ timeout: 10_000 });

    // Skills
    await page.getByTestId("nav-skills").click();
    await expect(page.getByTestId("skills-table").or(page.getByTestId("skills-empty"))).toBeVisible({ timeout: 10_000 });

    // Memory
    await page.getByTestId("nav-memory").click();
    await expect(page.getByTestId("project-memory-loading").or(page.getByTestId("project-memory-content"))).toBeVisible({ timeout: 10_000 });

    // Logs
    await page.getByTestId("nav-logs").click();
    await expect(page.getByTestId("logs-sessions")).toBeVisible({ timeout: 10_000 });

    // Webhooks
    await page.getByTestId("nav-webhooks").click();
    await expect(
      page.getByTestId("webhooks-list")
        .or(page.getByTestId("webhooks-empty"))
        .or(page.getByTestId("webhook-add-btn"))
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Breadcrumb navigation", () => {
  test("sidebar back-to-projects works after deep navigation", async ({ page }) => {
    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();
    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip(true, "No projects");
      return;
    }

    // Go deep: projects -> project -> agents -> sessions
    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/);
    await page.getByTestId("nav-sessions").click();
    await page.waitForURL(/\/sessions/);

    // Back to projects
    await page.getByTestId("nav-back-projects").click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByTestId("projects-page")).toBeVisible();
  });
});
