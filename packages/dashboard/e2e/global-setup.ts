import { test as setup, expect } from "@playwright/test";

/**
 * Shared E2E credentials.
 * Aligned with packages/server/tests/integration/auth.test.ts defaults.
 *
 * Override via env vars:
 *   E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_USER_NAME
 */
const EMAIL = process.env.E2E_USER_EMAIL ?? "e2e@polpo.dev";
const PASSWORD = process.env.E2E_USER_PASSWORD ?? "SecurePass123!";
const NAME = process.env.E2E_USER_NAME ?? "E2E Test User";

/**
 * Authenticate once and save storage state for all tests.
 *
 * Flow:
 * 1. Try to sign up (idempotent — will fail silently if user exists)
 * 2. Sign in
 * 3. Wait for redirect to /projects
 * 4. Save cookies to e2e/.auth/user.json
 */
setup("authenticate", async ({ page }) => {
  await page.goto("/login");

  // ── Step 1: Try signup first (no-op if account exists) ──
  const signUpBtn = page.getByRole("button", { name: "Sign up" });
  if (await signUpBtn.isVisible().catch(() => false)) {
    await signUpBtn.click();

    await page.getByPlaceholder("Your name").fill(NAME);
    await page.getByPlaceholder("you@company.com").fill(EMAIL);
    await page.getByPlaceholder("Min 8 characters").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // Wait for either redirect (success) or error (user exists)
    await Promise.race([
      page.waitForURL("**/projects", { timeout: 10_000 }),
      page.waitForSelector("[class*='destructive']", { timeout: 5_000 }),
    ]).catch(() => {});

    // If redirected, we're done — save state and return
    if (page.url().includes("/projects")) {
      await page.context().storageState({ path: "e2e/.auth/user.json" });
      return;
    }

    // Signup failed (user exists) — switch back to login
    const signInBtn = page.getByRole("button", { name: "Sign in" });
    if (await signInBtn.isVisible().catch(() => false)) {
      await signInBtn.click();
    } else {
      await page.goto("/login");
    }
  }

  // ── Step 2: Sign in ──
  await page.getByPlaceholder("you@company.com").fill(EMAIL);
  await page.getByPlaceholder("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Wait for redirect to /projects
  await page.waitForURL("**/projects", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/projects/);

  // Save auth state
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});
