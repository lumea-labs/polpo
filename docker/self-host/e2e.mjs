import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const compose = ["compose", "-f", "docker/self-host/compose.yml"];
const keepRunning = process.env.SELF_HOST_KEEP_RUNNING === "1";
const expectedVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed with exit code ${result.status}`);
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${await response.text()}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
}

function data(body) {
  return body?.data ?? body;
}

async function run() {
  docker([...compose, "down", "--volumes", "--remove-orphans"]);
  docker([...compose, "up", "--build", "--detach", "--wait"]);

  const health = await waitFor("http://127.0.0.1:13000/api/health");
  const healthBody = await health.json();
  if (healthBody?.data?.version !== expectedVersion) {
    throw new Error(`Runtime health reported ${healthBody?.data?.version}, expected ${expectedVersion}`);
  }

  const directWithoutKey = await fetch("http://127.0.0.1:13890/api/v1/agents");
  if (directWithoutKey.status !== 401) throw new Error(`Runtime auth expected 401, got ${directWithoutKey.status}`);

  const directWithBearer = await fetch("http://127.0.0.1:13890/api/v1/agents", {
    headers: { authorization: "Bearer polpo-e2e-secret" },
  });
  if (!directWithBearer.ok) throw new Error(`Runtime bearer auth failed: ${directWithBearer.status}`);

  const created = await json("http://127.0.0.1:13000/api/polpo/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "e2e-agent",
      role: "Self-host verification",
      model: "mock/e2e-model",
      systemPrompt: "Reply concisely.",
    }),
  });
  if (data(created.body)?.added !== true) throw new Error(`Agent creation returned an unexpected payload: ${JSON.stringify(created.body)}`);

  const completion = await json("http://127.0.0.1:13000/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "e2e-agent",
      stream: false,
      messages: [{ role: "user", content: "Confirm the self-hosted runtime is operational." }],
    }),
  });
  const text = completion.body?.choices?.[0]?.message?.content;
  if (text !== "Self-hosted Polpo is operational.") throw new Error(`Unexpected completion: ${JSON.stringify(completion.body)}`);

  const agents = await json("http://127.0.0.1:13000/api/polpo/agents");
  if (!data(agents.body)?.some?.((agent) => agent.name === "e2e-agent")) throw new Error("Created agent is not persisted");

  const sessions = await json("http://127.0.0.1:13000/api/polpo/chat/sessions");
  if (!Array.isArray(data(sessions.body)?.sessions)) throw new Error(`Sessions endpoint returned an unexpected payload: ${JSON.stringify(sessions.body)}`);

  const page = await fetch("http://127.0.0.1:13000/agents");
  if (!page.ok || !(await page.text()).includes("Polpo")) throw new Error("Dashboard HTML did not render");

  console.log("\nSelf-host E2E passed:");
  console.log("  - isolated PostgreSQL schema initialized");
  console.log(`  - runtime health reported version ${expectedVersion}`);
  console.log("  - runtime API authentication enforced");
  console.log("  - dashboard proxy kept the API key server-side");
  console.log("  - agent created and read back");
  console.log("  - real completion path exercised through an OpenAI-compatible model service");
  console.log("  - dashboard rendered at http://127.0.0.1:13000\n");
}

try {
  await run();
} catch (cause) {
  console.error(cause);
  try { docker([...compose, "logs", "--no-color", "--tail", "200"]); } catch {}
  process.exitCode = 1;
} finally {
  if (!keepRunning) {
    try { docker([...compose, "down", "--volumes", "--remove-orphans"]); } catch {}
  }
}
