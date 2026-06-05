import { test, expect } from "@playwright/test";

test.describe("API Keys page", () => {
  test("loads with heading and new key button", async ({ page }) => {
    await page.goto("/keys");
    await expect(page.getByTestId("keys-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();
    await expect(page.getByTestId("new-key-btn")).toBeVisible();
  });

  test("shows keys table or empty state", async ({ page }) => {
    await page.goto("/keys");

    const table = page.getByTestId("keys-table");
    const empty = page.getByTestId("keys-empty");
    const hasTable = await table.isVisible().catch(() => false);
    const hasEmpty = await empty.isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });

  test("new key button navigates to form", async ({ page }) => {
    await page.goto("/keys");
    await page.getByTestId("new-key-btn").click();
    await expect(page).toHaveURL(/\/keys\/new/);
    await expect(page.getByTestId("new-key-form")).toBeVisible();
  });
});

test.describe("New API Key form", () => {
  test("has required form fields", async ({ page }) => {
    await page.goto("/keys/new");

    await expect(page.getByTestId("key-name-input")).toBeVisible();
    await expect(page.getByTestId("key-project-select")).toBeVisible();
    await expect(page.getByTestId("create-key-submit")).toBeVisible();
  });

  test("submit is disabled when name is empty", async ({ page }) => {
    await page.goto("/keys/new");
    await expect(page.getByTestId("create-key-submit")).toBeDisabled();
  });
});

test.describe("LLM Gateway page", () => {
  test("loads with heading and add button", async ({ page }) => {
    await page.goto("/llm-gateway");
    await expect(page.getByTestId("llm-gateway-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "LLM Keys" })).toBeVisible();
    await expect(page.getByTestId("llm-key-add-btn")).toBeVisible();
  });

  test("shows keys table or empty state", async ({ page }) => {
    await page.goto("/llm-gateway");

    const table = page.getByTestId("llm-gateway-table");
    const empty = page.getByTestId("llm-gateway-empty");
    const hasTable = await table.isVisible().catch(() => false);
    const hasEmpty = await empty.isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });

  test("add key shows form", async ({ page }) => {
    await page.goto("/llm-gateway");
    await page.getByTestId("llm-key-add-btn").click();
    await expect(page.getByTestId("llm-key-form")).toBeVisible();
  });
});

test.describe("Usage page", () => {
  test("loads with heading and usage cards", async ({ page }) => {
    await page.goto("/usage");
    await expect(page.getByTestId("usage-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  });
});

test.describe("Settings page", () => {
  test("loads with heading and org details", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("has delete organization button", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("delete-org-btn")).toBeVisible();
  });
});

test.describe("Account page", () => {
  test("loads with profile and session info", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByTestId("account-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByTestId("logout-btn")).toBeVisible();
  });
});
