import { proxyRuntime } from "../../../../lib/runtime-proxy";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return proxyRuntime(request, "/v1/chat/completions");
}
