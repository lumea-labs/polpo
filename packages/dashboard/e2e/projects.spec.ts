import { test, expect } from "@playwright/test";

test.describe("Projects page", () => {
  test("loads projects page with heading", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  });

  test("shows new project button", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByTestId("new-project-btn")).toBeVisible();
    await expect(page.getByTestId("new-project-btn")).toHaveText(/New project/);
  });

  test("shows projects grid or empty state", async ({ page }) => {
    await page.goto("/projects");

    const grid = page.getByTestId("projects-grid");
    const empty = page.getByTestId("projects-empty");

    // One of the two should be visible
    const hasGrid = await grid.isVisible().catch(() => false);
    const hasEmpty = await empty.isVisible().catch(() => false);
    expect(hasGrid || hasEmpty).toBe(true);
  });

  test("project card navigates to project detail", async ({ page }) => {
    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();

    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstCard.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+/);
    await expect(page.getByTestId("project-detail")).toBeVisible();
    await expect(page.getByTestId("project-name")).toBeVisible();
  });
});

test.describe("New project form", () => {
  test("navigates to new project page", async ({ page }) => {
    await page.goto("/projects");
    await page.getByTestId("new-project-btn").click();
    await expect(page).toHaveURL(/\/projects\/new/);
  });

  test("form has required fields", async ({ page }) => {
    await page.goto("/projects/new");

    await expect(page.getByTestId("new-project-form")).toBeVisible();
    await expect(page.getByTestId("project-name-input")).toBeVisible();
    // Slug input was removed: slug is now server-generated (20-char opaque ref).
    await expect(page.getByTestId("create-project-submit")).toBeVisible();
  });

  test("submit button is disabled when name is empty", async ({ page }) => {
    await page.goto("/projects/new");
    await expect(page.getByTestId("create-project-submit")).toBeDisabled();
  });
});
