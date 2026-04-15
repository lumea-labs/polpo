/**
 * Convert a human-readable project name into a URL-safe slug.
 * Shared between `polpo create` and `polpo deploy` auto-create so slugs
 * produced from the same name are identical.
 *
 * Rules:
 *   - lowercase
 *   - any non a-z0-9 collapses to a single hyphen
 *   - leading/trailing hyphens stripped
 *   - empty result → "project"
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}
