import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { toAITools } from "./tool-mapping.js";

const runLiveGatewayTests =
  process.env.POLPO_LIVE_GATEWAY_TESTS === "1" &&
  Boolean(process.env.AI_GATEWAY_API_KEY);

describe.runIf(runLiveGatewayTests)("portable tool schemas against AI Gateway", () => {
  it("supports constrained custom tools through a dynamically routed xAI model", async () => {
    const tools = toAITools([
      {
        name: "validate_weekly_nutrition_plan",
        description: "Validate a seven-day nutrition plan.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: [
            "planJson",
            "targetCalories",
            "targetProteinG",
            "targetCarbohydrateG",
            "targetFatG",
          ],
          properties: {
            planJson: {
              type: "string",
              minLength: 2,
            },
            targetCalories: {
              type: "number",
              minimum: 1000,
              maximum: 5000,
            },
            targetProteinG: {
              type: "number",
              minimum: 1,
            },
            targetCarbohydrateG: {
              type: "number",
              minimum: 1,
            },
            targetFatG: {
              type: "number",
              minimum: 1,
            },
            tolerancePercent: {
              type: "number",
              minimum: 1,
              maximum: 15,
              default: 10,
            },
          },
        },
      },
    ]);

    const result = await generateText({
      model: "xai/grok-4.1-fast-non-reasoning",
      prompt:
        "Validate an empty weekly plan with targets 2000 calories, 120 protein, 220 carbohydrate, and 70 fat.",
      tools,
      toolChoice: {
        type: "tool",
        toolName: "validate_weekly_nutrition_plan",
      },
    });

    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "validate_weekly_nutrition_plan",
        input: expect.objectContaining({
          planJson: "[]",
          targetCalories: expect.any(Number),
          targetProteinG: expect.any(Number),
          targetCarbohydrateG: expect.any(Number),
          targetFatG: expect.any(Number),
        }),
      }),
    ]);
  }, 30_000);
});
