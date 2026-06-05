import { test, expect } from "@playwright/test";

const UNIQUE = Date.now().toString(36);
const PROJECT_NAME = `E2E Project ${UNIQUE}`;

test.describe.serial("Project CRUD", () => {
  test("create a new project via form", async ({ page }) => {
    await page.goto("/projects/new");

    await page.getByTestId("project-name-input").fill(PROJECT_NAME);
    await page.getByTestId("create-project-submit").click();

    // Should redirect to the new project detail page (UUID, not slug)
    await page.waitForURL(/\/projects\/[a-z0-9-]+/, { timeout: 15_000 });
    await expect(page.getByTestId("project-name")).toHaveText(PROJECT_NAME);
  });

  test("new project appears in the projects list", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByTestId("projects-grid")).toBeVisible();

    // Find the card by name (slug is now an opaque server-generated ref).
    const card = page.locator('[data-testid^="project-card-"]', { hasText: PROJECT_NAME });
    await expect(card.first()).toBeVisible({ timeout: 5_000 });
  });

  test("project detail shows overview with stat cards", async ({ page }) => {
    await page.goto("/projects");
    const card = page.locator('[data-testid^="project-card-"]', { hasText: PROJECT_NAME });
    await card.first().click();
    await page.waitForURL(/\/projects\/[^/]+/);

    // Overview stats should render (fresh project = 0 agents, 0 tasks)
    const stats = page.getByTestId("overview-stats");
    await expect(stats).toBeVisible({ timeout: 10_000 });

    // Empty project has 0 agents
    await expect(stats).toContainText("0");
  });

  test("empty project shows correct empty states in all tabs", async ({ page }) => {
    await page.goto("/projects");
    const card = page.locator('[data-testid^="project-card-"]', { hasText: PROJECT_NAME });
    await card.first().click();
    await page.waitForURL(/\/projects\/[^/]+/);

    // Agents tab
    await page.getByTestId("nav-agents").click();
    await expect(page.getByTestId("agents-empty")).toBeVisible({ timeout: 10_000 });

    // Tasks tab
    await page.getByTestId("nav-tasks").click();
    await expect(page.getByTestId("tasks-empty")).toBeVisible({ timeout: 10_000 });

    // Sessions tab
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByTestId("sessions-empty")).toBeVisible({ timeout: 10_000 });

    // Missions tab
    await page.getByTestId("nav-missions").click();
    await expect(page.getByTestId("missions-empty")).toBeVisible({ timeout: 10_000 });

    // Skills tab
    await page.getByTestId("nav-skills").click();
    await expect(page.getByTestId("skills-empty")).toBeVisible({ timeout: 10_000 });
  });
});
