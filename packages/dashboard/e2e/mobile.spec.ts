import { test, expect } from "@playwright/test";

// These tests only run on the "mobile" project (iPhone 14 viewport)
test.describe("Mobile navigation", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "mobile project only");

  test("desktop sidebar is hidden, hamburger is visible", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");

    await page.goto("/projects");

    await expect(page.getByTestId("sidebar")).not.toBeVisible();
    await expect(page.getByTestId("mobile-menu-toggle")).toBeVisible();
  });

  test("hamburger opens mobile sidebar drawer", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");

    await page.goto("/projects");

    await page.getByTestId("mobile-menu-toggle").click();

    // Sidebar content should now be visible (in the sheet)
    await expect(page.getByTestId("sidebar-nav")).toBeVisible();
    await expect(page.getByTestId("org-switcher")).toBeVisible();
  });

  test("navigating closes mobile sidebar", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");

    await page.goto("/projects");

    await page.getByTestId("mobile-menu-toggle").click();
    await expect(page.getByTestId("sidebar-nav")).toBeVisible();

    // Click a nav link
    await page.getByTestId("nav-settings").click();
    await expect(page).toHaveURL(/\/settings/);

    // Sidebar should be closed now
    await expect(page.getByTestId("sidebar-nav")).not.toBeVisible();
  });

  test("projects page is usable on mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");

    await page.goto("/projects");

    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page.getByTestId("new-project-btn")).toBeVisible();

    // Content should not overflow horizontally
    const body = page.locator("body");
    const bodyWidth = await body.evaluate((el) => el.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 0;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1); // 1px tolerance
  });

  test("nav tabs are horizontally scrollable on mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");

    await page.goto("/projects");
    const firstCard = page.locator("[data-testid^='project-card-']").first();
    if (!(await firstCard.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/);

    const tabs = page.getByTestId("nav-tabs");
    await expect(tabs).toBeVisible();

    // Tabs container should have overflow-x: auto or scroll
    const overflowX = await tabs.evaluate((el) => getComputedStyle(el).overflowX);
    expect(["auto", "scroll"]).toContain(overflowX);
  });
});
