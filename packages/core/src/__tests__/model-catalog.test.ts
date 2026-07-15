import { describe, expect, it } from "vitest";
import {
  isModelCatalogCapability,
  isModelCatalogLegacyType,
  isModelCatalogModality,
  normalizeModelCatalogSearchFilters,
} from "../model-catalog.js";

describe("model catalog normalization", () => {
  it("keeps canonical legacy type filters", () => {
    expect(normalizeModelCatalogSearchFilters({ type: "language" })).toEqual({
      type: "language",
      modality: "text",
      capabilities: [],
      warnings: [],
    });
    expect(normalizeModelCatalogSearchFilters({ type: "audio" })).toEqual({
      type: "audio",
      modality: "audio",
      capabilities: [],
      warnings: [],
    });
  });

  it("maps speech and transcription legacy aliases to audio capability filters", () => {
    expect(normalizeModelCatalogSearchFilters({ type: "speech" })).toMatchObject({
      type: "audio",
      modality: "audio",
      capabilities: ["speech"],
    });
    expect(normalizeModelCatalogSearchFilters({ type: "transcription" })).toMatchObject({
      type: "audio",
      modality: "audio",
      capabilities: ["transcription"],
    });
  });

  it("prefers modality/capability filters for new callers", () => {
    expect(normalizeModelCatalogSearchFilters({
      modality: "audio",
      capability: "speech",
      capabilities: ["speech", "fast"],
    })).toEqual({
      type: "audio",
      modality: "audio",
      capabilities: ["fast", "speech"],
      warnings: [],
    });
  });

  it("normalizes common dash/underscore capability spellings", () => {
    expect(normalizeModelCatalogSearchFilters({
      capabilities: ["structured-output", "file_input"],
    }).capabilities).toEqual(["file_input", "structured_output"]);
  });

  it("throws clear errors for unsupported filters", () => {
    expect(() => normalizeModelCatalogSearchFilters({ type: "database" })).toThrow(/Unsupported model type "database"/);
    expect(() => normalizeModelCatalogSearchFilters({ modality: "database" })).toThrow(/Unsupported model modality "database"/);
    expect(() => normalizeModelCatalogSearchFilters({ capability: "sql" })).toThrow(/Unsupported model capability "sql"/);
  });

  it("exports type guards for host schemas", () => {
    expect(isModelCatalogLegacyType("language")).toBe(true);
    expect(isModelCatalogLegacyType("speech")).toBe(false);
    expect(isModelCatalogModality("audio")).toBe(true);
    expect(isModelCatalogCapability("speech")).toBe(true);
  });
});
