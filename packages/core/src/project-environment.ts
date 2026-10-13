/** Public project environments. These names do not confer authorization. */
export const PROJECT_ENVIRONMENTS = ["development", "production"] as const;
export type ProjectEnvironment = (typeof PROJECT_ENVIRONMENTS)[number];

export function parseProjectEnvironment(value: unknown): ProjectEnvironment {
  if (value !== "development" && value !== "production") {
    throw new TypeError("Project environment must be development or production");
  }
  return value;
}

/**
 * Explicit selection is part of the URL so an older server cannot ignore a
 * selector header and write into its default runtime. The host still must
 * authorize the selected environment against the verified credential.
 */
export function projectEnvironmentBaseUrl(baseUrl: string, environment: ProjectEnvironment): string {
  const name = parseProjectEnvironment(environment);
  if (/[?#\\\r\n]/.test(baseUrl)) {
    throw new TypeError("An environment base URL cannot contain a query, fragment or backslash");
  }
  const base = baseUrl.replace(/\/+$/, "");
  const pathname = new URL(base || "/", "http://polpo.invalid").pathname;
  const segments = pathname.split("/");
  const selector = segments.indexOf("environments");
  if (selector !== -1) {
    if (selector !== segments.length - 2 || segments.lastIndexOf("environments") !== selector) {
      throw new TypeError("Ambiguous project environment base URL");
    }
    if (parseProjectEnvironment(segments[selector + 1]) !== name) {
      throw new TypeError("Project environment conflicts with the base URL");
    }
    return base;
  }
  return `${base}/environments/${name}`;
}

/** Parse a gateway-relative pathname; absence is distinct from Development. */
export function readProjectEnvironmentPath(pathname: string): {
  environment: ProjectEnvironment;
  path: string;
} | undefined {
  if (pathname === "/environments") throw new TypeError("Missing project environment");
  if (!pathname.startsWith("/environments/")) return undefined;
  const [name, ...rest] = pathname.slice("/environments/".length).split("/");
  const environment = parseProjectEnvironment(name);
  const path = `/${rest.join("/")}`;
  if (rest[0] === "environments") throw new TypeError("Nested project environment selection is not allowed");
  return { environment, path };
}
