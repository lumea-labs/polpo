/**
 * Shared "call this agent" snippets — the single source for the code shown in
 * the agent Run dialog AND the onboarding "call it via API" step (DRY). Given a
 * tenant base URL + agent + a chat message or a task, it builds curl / SDK /
 * Python / coding-agent snippets for the OpenAI-compatible data-plane API.
 */

export type CallLang = "curl" | "ts" | "python" | "agent";

export const CALL_LANGS: { id: CallLang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "ts", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "agent", label: "Coding agent" },
];

/** Tenant data-plane base URL — mirrors settings' `tenantApiUrl(slug)`. */
export function tenantBase(slug?: string): string {
  if (!slug) return "https://<your-project>.polpo.cloud";
  if (process.env.NEXT_PUBLIC_API_URL?.includes("localhost")) {
    return `http://${slug}.polpo.localhost`;
  }
  return `https://${slug}.polpo.cloud`;
}

export type CallSnippetInput = {
  base: string;
  agentName: string;
  /** true = streaming chat (`/v1/chat/completions`), false = background task. */
  streaming: boolean;
  message: string;
  taskTitle: string;
  taskDesc: string;
};

export type CallSnippets = {
  curl: string;
  ts: string;
  python: string;
  agentPrompt: string;
  /** Resolve a language to `{ code, codeLang }` for a <CodeBlock>. */
  pick: (lang: CallLang) => { code: string; codeLang: string };
};

export function buildCallSnippets(i: CallSnippetInput): CallSnippets {
  const { base, agentName, streaming, message, taskTitle, taskDesc } = i;

  const bodyObj = streaming
    ? {
        agent: agentName,
        messages: [{ role: "user", content: message }],
        stream: true,
      }
    : { assignTo: agentName, title: taskTitle, description: taskDesc };
  const path = streaming ? "/v1/chat/completions" : "/v1/tasks";
  const json2 = JSON.stringify(bodyObj, null, 2);
  const pyStr = (s: string) => JSON.stringify(s);

  const curl = `curl ${streaming ? "-N " : ""}${base}${path} \\
  -H "Authorization: Bearer $POLPO_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${json2}'`;

  const ts = `import { PolpoClient } from "@polpo-ai/sdk";

const polpo = new PolpoClient({
  baseUrl: "${base}",
  apiKey: process.env.POLPO_API_KEY!,
});

${
  streaming
    ? `const stream = polpo.chatCompletionsStream(${json2});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`
    : `const task = await polpo.createTask(${json2});
console.log("task:", task.id);`
}`;

  const python = streaming
    ? `import json, os, requests

with requests.post(
    "${base}${path}",
    headers={"Authorization": f"Bearer {os.environ['POLPO_API_KEY']}", "Content-Type": "application/json"},
    json={
        "agent": ${pyStr(agentName)},
        "messages": [{"role": "user", "content": ${pyStr(message)}}],
        "stream": True,
    },
    stream=True,
) as r:
    for line in r.iter_lines():
        if not line or not line.startswith(b"data: "):
            continue
        data = line[6:]
        if data == b"[DONE]":
            break
        delta = json.loads(data)["choices"][0]["delta"]
        print(delta.get("content", ""), end="", flush=True)`
    : `import os, requests

r = requests.post(
    "${base}${path}",
    headers={"Authorization": f"Bearer {os.environ['POLPO_API_KEY']}", "Content-Type": "application/json"},
    json={
        "assignTo": ${pyStr(agentName)},
        "title": ${pyStr(taskTitle)},
        "description": ${pyStr(taskDesc)},
    },
)
print(r.json())`;

  const agentPrompt = streaming
    ? `You can call the Polpo agent "${agentName}" — a ready-made agent with its own model, tools, skills, and instructions. Use it instead of building this behaviour from scratch.

Call it as a streaming chat (OpenAI-compatible, SSE):
  POST ${base}/v1/chat/completions
  Headers: Authorization: Bearer <POLPO_API_KEY>, Content-Type: application/json
  Body: { "agent": "${agentName}", "messages": [{ "role": "user", "content": "…" }], "stream": true }
  Concatenate choices[0].delta.content from each \`data: {…}\` chunk; stop at \`data: [DONE]\`.

If a Polpo SDK or skill is available, use it — new PolpoClient({ baseUrl: "${base}", apiKey }) → polpo.chatCompletionsStream(req); otherwise call the HTTP endpoint directly. Read the key from a POLPO_API_KEY env var, never hard-code it.`
    : `You can call the Polpo agent "${agentName}" — a ready-made agent with its own model, tools, skills, and instructions. Use it instead of building this behaviour from scratch.

Call it as a background task:
  POST ${base}/v1/tasks
  Headers: Authorization: Bearer <POLPO_API_KEY>, Content-Type: application/json
  Body: { "assignTo": "${agentName}", "title": "…", "description": "…" }
  Returns a task id; poll GET /v1/tasks/<id> for its status and result.

If a Polpo SDK or skill is available, use it — new PolpoClient({ baseUrl: "${base}", apiKey }) → polpo.createTask(req); otherwise call the HTTP endpoint directly. Read the key from a POLPO_API_KEY env var, never hard-code it.`;

  const pick = (lang: CallLang) =>
    lang === "curl"
      ? { code: curl, codeLang: "bash" }
      : lang === "ts"
        ? { code: ts, codeLang: "typescript" }
        : lang === "python"
          ? { code: python, codeLang: "python" }
          : { code: agentPrompt, codeLang: "markdown" };

  return { curl, ts, python, agentPrompt, pick };
}
