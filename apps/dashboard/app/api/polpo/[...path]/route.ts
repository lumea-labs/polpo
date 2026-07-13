import { proxyRuntime } from "../../../../lib/runtime-proxy";

export const dynamic = "force-dynamic";

async function handler(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyRuntime(request, `/api/v1/${path.map(encodeURIComponent).join("/")}`);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
