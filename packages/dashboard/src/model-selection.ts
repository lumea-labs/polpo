import type {
  ModelProfileReference,
  ModelTarget,
  ProfiledModelSelection,
} from "@polpo-ai/sdk";

function isProfileReference(
  model: ModelTarget | ProfiledModelSelection,
): model is ModelProfileReference {
  return typeof model === "object" && "profile" in model;
}

function modelTargetInputValue(target: ModelTarget): string {
  return typeof target === "string" ? target : `profile:${target.profile}`;
}

function modelTargetLabel(target: ModelTarget): string {
  return typeof target === "string" ? target : `${target.profile} (profile)`;
}

export function modelSelectionPrimary(model?: ProfiledModelSelection): string {
  if (!model) return "";
  if (typeof model === "string") return model;
  if (isProfileReference(model)) return modelTargetInputValue(model);
  return modelTargetInputValue(model.primary);
}

export function modelSelectionLabel(model?: ProfiledModelSelection): string {
  if (!model) return "Not assigned";
  const primary = typeof model === "string"
    ? model.trim()
    : isProfileReference(model)
      ? modelTargetLabel(model)
      : modelTargetLabel(model.primary);
  if (!primary) return "Not assigned";
  if (typeof model === "string" || isProfileReference(model)) return primary;
  const fallbackCount = model.fallbacks?.length ?? 0;
  return fallbackCount > 0 ? `${primary} +${fallbackCount}` : primary;
}

export function parseModelSelectionInput(value: string): ProfiledModelSelection | undefined {
  const input = value.trim();
  if (!input) return undefined;
  if (!input.startsWith("profile:")) return input;
  return { profile: input.slice("profile:".length).trim() };
}
