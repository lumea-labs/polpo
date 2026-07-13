import { describe, expect, it } from "vitest";
import { healthRoutes } from "./health.js";

describe("healthRoutes", () => {
  it("reports the runtime version supplied by the host", async () => {
    const response = await healthRoutes("1.2.3").request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "ok", version: "1.2.3" },
    });
  });
});
