import { test, expect } from "@playwright/test";

test.describe("Sidebar navigation", () => {
  test("renders sidebar with logo, org switcher and nav links", async ({ page }) => {
    await page.goto("/projects");

    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId("sidebar-logo")).toBeVisible();
    await expect(page.getByTestId("org-switcher")).toBeVisible();
    await expect(page.getByTestId("sidebar-nav")).toBeVisible();
  });

  test("shows global nav links on root pages", async ({ page }) => {
    await page.goto("/projects");

    await expect(page.getByTestId("nav-projects")).toBeVisible();
    await expect(page.getByTestId("nav-api-keys")).toBeVisible();
    await expect(page.getByTestId("nav-llm-gateway")).toBeVisible();
    await expect(page.getByTestId("nav-usage-&-billing")).toBeVisible();
    await expect(page.getByTestId("nav-settings")).toBeVisible();
  });

  test("shows docs link and user link", async ({ page }) => {
    await page.goto("/projects");

    await expect(page.getByTestId("nav-docs")).toHaveAttribute("href", "https://docs.polpo.dev");
    await expect(page.getByTestId("nav-user")).toBeVisible();
  });

  test("navigates between global pages", async ({ page }) => {
    await page.goto("/projects");

    await page.getByTestId("nav-api-keys").click();
    await expect(page).toHaveURL(/\/keys/);

    await page.getByTestId("nav-usage-&-billing").click();
    await expect(page).toHaveURL(/\/usage/);

    await page.getByTestId("nav-settings").click();
    await expect(page).toHaveURL(/\/settings/);
  });
});

test.describe("Sidebar - project context", () => {
  test("shows project nav and back link inside a project", async ({ page }) => {
    // Navigate to first project (assumes at least one exists)
    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();

    // Skip if no projects
    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/);

    // Should show project nav
    await expect(page.getByTestId("nav-back-projects")).toBeVisible();
    await expect(page.getByTestId("nav-overview")).toBeVisible();
    await expect(page.getByTestId("nav-agents")).toBeVisible();
    await expect(page.getByTestId("nav-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-tasks")).toBeVisible();
    await expect(page.getByTestId("nav-missions")).toBeVisible();
  });

  test("back link returns to projects list", async ({ page }) => {
    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();
    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/);

    await page.getByTestId("nav-back-projects").click();
    await expect(page).toHaveURL(/\/projects$/);
  });
});
