import { proxyRuntime } from "../../../lib/runtime-proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxyRuntime(request, "/api/v1/health");
}
