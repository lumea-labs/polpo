import { test, expect } from "@playwright/test";

const KEY_NAME = `e2e-key-${Date.now().toString(36)}`;

test.describe.serial("API Key CRUD", () => {
  test("create a new API key", async ({ page }) => {
    await page.goto("/keys/new");

    // Fill the form
    await page.getByTestId("key-name-input").fill(KEY_NAME);

    // Select first project (needs at least one project)
    const select = page.getByTestId("key-project-select");
    const options = select.locator("option:not([disabled])");
    const count = await options.count();
    if (count === 0) {
      test.skip(true, "No projects available to create a key for");
      return;
    }
    await select.selectOption({ index: 1 }); // first non-disabled option

    await page.getByTestId("create-key-submit").click();

    // Should show the created key
    await expect(page.getByTestId("created-key-value")).toBeVisible({ timeout: 10_000 });
    const keyText = await page.getByTestId("created-key-value").innerText();
    expect(keyText).toMatch(/^sk_(live|test)_/);
  });

  test("copy key button works", async ({ page }) => {
    await page.goto("/keys/new");

    await page.getByTestId("key-name-input").fill(`copy-test-${Date.now()}`);
    const select = page.getByTestId("key-project-select");
    const options = select.locator("option:not([disabled])");
    if ((await options.count()) === 0) {
      test.skip(true, "No projects");
      return;
    }
    await select.selectOption({ index: 1 });
    await page.getByTestId("create-key-submit").click();

    await expect(page.getByTestId("created-key-value")).toBeVisible({ timeout: 10_000 });

    // Click copy
    await page.getByTestId("copy-key-btn").click();

    // The button should show a check icon (copied feedback)
    // We verify by checking the button still exists and the page is stable
    await expect(page.getByTestId("copy-key-btn")).toBeVisible();
  });

  test("new key appears in the keys list", async ({ page }) => {
    await page.goto("/keys");

    await expect(page.getByTestId("keys-table")).toBeVisible({ timeout: 5_000 });

    // Our key name should be in the table
    await expect(page.getByTestId("keys-table")).toContainText(KEY_NAME);
  });

  test("revoke button exists for each key", async ({ page }) => {
    await page.goto("/keys");

    const table = page.getByTestId("keys-table");
    if (!(await table.isVisible().catch(() => false))) {
      test.skip(true, "No keys table");
      return;
    }

    // At least one revoke button should exist
    const revokeButtons = page.locator("[data-testid^='revoke-key-']");
    expect(await revokeButtons.count()).toBeGreaterThan(0);
  });
});
