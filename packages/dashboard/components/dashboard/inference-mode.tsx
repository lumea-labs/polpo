import type { ReactNode } from "react";

/**
 * Single-tenant stub. The inference-mode selector (BYOK vs managed gateway
 * credits) is a cloud-billing concept with no meaning in self-host, where all
 * inference is BYOK. Kept as a pass-through wrapper so the settings form
 * compiles; the managed-credits UI ships only in the cloud build.
 */
export type InferenceMode = string;

export function InferenceModeRadio({
  children,
}: { children?: ReactNode } & Record<string, unknown>) {
  return <>{children}</>;
}
