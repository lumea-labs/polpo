import {
  parseProjectEnvironment,
  readProjectEnvironmentPath,
  type ProjectEnvironment,
} from "@polpo-ai/core/project-environment";

/**
 * Route explicit selectors to ONE operator-bound runtime. This does not grant
 * access or select stores: downstream authentication remains mandatory, and
 * the host must give each process its own resources. An unbound legacy runtime
 * cannot accept an explicit target by silently using its default instance.
 */
export async function routeProjectEnvironment(
  request: Request,
  environment: ProjectEnvironment | undefined,
  forward: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  if (environment !== undefined) parseProjectEnvironment(environment);
  const url = new URL(request.url);
  const apiPrefix = url.pathname === "/api/environments" || url.pathname.startsWith("/api/environments/") ? "/api" : "";
  let target;
  try {
    target = readProjectEnvironmentPath(url.pathname.slice(apiPrefix.length));
    if (target?.path.startsWith("/api/environments/")) {
      throw new TypeError("Nested project environment selection is not allowed");
    }
  } catch {
    return Response.json({ ok: false, error: "Invalid project environment selector", code: "INVALID_ENVIRONMENT" }, { status: 400 });
  }
  if (!target) return forward(request);
  if (environment === undefined || target.environment !== environment) {
    return Response.json({ ok: false, error: "Environment is not available on this runtime", code: "ENVIRONMENT_NOT_FOUND" }, { status: 404 });
  }
  url.pathname = `${apiPrefix}${target.path}`;
  return forward(new Request(url, request));
}
