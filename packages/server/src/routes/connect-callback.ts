import { Hono } from "hono";
import { ConnectError } from "@polpo-ai/connect";
import type { ConnectRouteDeps } from "../deps.js";

/** Public browser callback only; all setup and management routes remain authenticated. */
export function connectCallbackRoutes(getDeps: () => ConnectRouteDeps) {
  const app = new Hono();
  app.get("/oauth/callback", async c => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const service = getDeps().connectService;
    if (!service) return c.text("Connection setup is unavailable.", 503);
    const state = c.req.query("state"), code = c.req.query("code"), error = c.req.query("error");
    if (!state || state.length > 512 || (code && code.length > 8192) || (error && error.length > 128)) {
      return c.text("Invalid connection callback. Start a new connection setup.", 400);
    }
    try {
      const result = await service.completeOAuthCallback({ state, code, error });
      if (result.returnUrl) return c.redirect(result.returnUrl, 303);
      return c.html("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Connection complete</title><h1>Connection complete</h1><p>You can return to the application.</p></html>");
    } catch (error) {
      const expired = error instanceof ConnectError && error.code === "oauth_state_expired";
      return c.text("Connection setup could not be completed. Return to the application and start again.", expired ? 410 : 400);
    }
  });
  return app;
}
