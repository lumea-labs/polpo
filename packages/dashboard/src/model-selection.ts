import type { ModelSelection } from "@polpo-ai/sdk";

export function modelSelectionPrimary(model?: ModelSelection): string {
  if (!model) return "";
  return typeof model === "string" ? model : model.primary ?? "";
}

export function modelSelectionLabel(model?: ModelSelection): string {
  if (!model) return "Not assigned";
  const primary = modelSelectionPrimary(model).trim();
  if (!primary) return "Not assigned";
  if (typeof model === "string") return primary;
  const fallbackCount = model.fallbacks?.filter((item) => item.trim()).length ?? 0;
  return fallbackCount > 0 ? `${primary} +${fallbackCount}` : primary;
}
