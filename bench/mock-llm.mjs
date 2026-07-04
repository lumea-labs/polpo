#!/usr/bin/env node
/**
 * bench/mock-llm.mjs — OpenAI-compatible mock LLM server for Polpo benchmarks.
 *
 * Speaks BOTH wire protocols the AI SDK can use against a custom baseUrl:
 *   - POST <base>/responses         (OpenAI Responses API — used by @ai-sdk/openai v3,
 *                                    which is what Polpo's provider override resolves to)
 *   - POST <base>/chat/completions  (OpenAI Chat Completions — for runtimes that use
 *                                    .chat() / openai-compatible providers)
 * Both support stream:true (SSE) and stream:false (JSON).
 *
 * Behavior is 100% scripted by a [BENCH ...] directive embedded in the first
 * user message (see lib/directive.mjs). The server is stateless per request:
 * the current turn is derived from the conversation history itself (bench
 * call ids encode sid+turn). A small in-memory registry keeps per-sid stats
 * and the directive params so sessions survive history compaction.
 *
 * Introspection:
 *   GET  /bench/stats/<sid>  → per-session stats (requests, turns, llmBusyMs, ...)
 *   GET  /bench/stats        → all sessions
 *   GET  /bench/debug        → ring buffer of recent request summaries
 *   POST /bench/reset        → clear registry + stats
 *   GET  /bench/health       → { ok: true }
 *
 * Zero npm dependencies — Node stdlib only.
 */

import { createServer } from "node:http";
import {
  DIRECTIVE_DEFAULTS,
  parseDirective,
  buildCallId,
  scanCallIds,
} from "./lib/directive.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Session registry ────────────────────────────────────────────────────────

function newStats() {
  return {
    requests: 0,
    streamRequests: 0,
    jsonRequests: 0,
    byEndpoint: { responses: 0, chat: 0 },
    turnsServed: 0, // highest tool-loop turn answered
    finals: 0, // final (stop) responses served
    summarizeCalls: 0, // tool-less requests (context compaction etc.)
    toolCallsEmitted: 0,
    outcomeCallsEmitted: 0,
    llmBusyMs: 0, // sum of artificial latency applied
    firstRequestAt: null,
    lastRequestAt: null,
    // Durable-execution observability (crash_resume): how many times each
    // turn was requested. A resumed session must NOT re-request completed
    // turns — turnRequests[t] > 1 for t ≤ checkpoint means re-execution.
    turnRequests: {},
    // Highest bench call-id turn seen INSIDE an incoming request (i.e. in
    // the conversation history the runtime sent us). After a crash+resume,
    // this proves the seeded checkpoint history actually reached the model.
    maxHistoryTurn: 0,
  };
}

export function createMockLlm({ port = 8377, host = "127.0.0.1", quiet = true } = {}) {
  /** sid → { params, stats } */
  const sessions = new Map();
  /** ring buffer of request summaries for debugging */
  const debugLog = [];
  const pushDebug = (entry) => {
    debugLog.push(entry);
    if (debugLog.length > 50) debugLog.shift();
  };

  const getSession = (sid, params) => {
    let s = sessions.get(sid);
    if (!s) {
      s = { params: params ?? { ...DIRECTIVE_DEFAULTS }, stats: newStats() };
      sessions.set(sid, s);
    } else if (params) {
      s.params = params; // refresh — directive re-seen
    }
    return s;
  };

  // ── Request text extraction (both protocols) ──────────────────────────────

  /** Collect all human-readable text from a request body (to find the directive). */
  function extractText(body) {
    const chunks = [];
    if (typeof body.instructions === "string") chunks.push(body.instructions);
    if (typeof body.system === "string") chunks.push(body.system);
    const items = Array.isArray(body.input)
      ? body.input
      : Array.isArray(body.messages)
        ? body.messages
        : [];
    if (typeof body.input === "string") chunks.push(body.input);
    for (const item of items) {
      if (typeof item?.content === "string") chunks.push(item.content);
      else if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string") chunks.push(part.text);
          if (typeof part?.input_text === "string") chunks.push(part.input_text);
        }
      }
      if (typeof item?.text === "string") chunks.push(item.text);
    }
    return chunks.join("\n");
  }

  /** Does the request carry tools? (tool-less ⇒ summarize/utility call) */
  function hasTools(body) {
    return Array.isArray(body.tools) && body.tools.length > 0;
  }

  /**
   * Current turn = max turn already answered (from bench call ids echoed in
   * history) + 1. Call ids live in call_id / tool_call_id fields, so we scan
   * the RAW request JSON, not just the text parts. Works identically for both
   * protocols and survives compaction as long as the previous turn's calls
   * are still in context. Falls back to counting assistant messages (chat).
   */
  function computeTurn(body, rawJson) {
    const scanned = scanCallIds(rawJson);
    let turn = scanned ? scanned.maxTurn + 1 : 1;
    if (Array.isArray(body.messages)) {
      const assistantCount = body.messages.filter((m) => m?.role === "assistant").length;
      turn = Math.max(turn, assistantCount + 1);
    }
    return turn;
  }

  // ── Behavior: decide what this response contains ──────────────────────────

  /**
   * Returns { kind: "tools", calls: [{id, name, args}] } or
   *         { kind: "text", text }
   */
  function decide(sid, params, turn) {
    const toolTurns = params.cap === "never" ? Infinity : params.turns;
    if (turn <= toolTurns) {
      const calls = [];
      for (let i = 0; i < params.toolsPerTurn; i++) {
        calls.push({
          id: buildCallId(sid, turn, i),
          name: "bash",
          args: JSON.stringify({
            command: `head -c ${params.toolOutputBytes} /dev/zero | tr '\\0' 'x'`,
            timeout: 30000,
          }),
        });
      }
      // Outcomes are emitted on the LAST tool turn
      if (params.outcomes > 0 && turn === params.turns) {
        for (let i = 0; i < params.outcomes; i++) {
          calls.push({
            id: buildCallId(sid, turn, params.toolsPerTurn + i),
            name: "register_outcome",
            args: JSON.stringify({
              type: "text",
              label: `bench-${i + 1}`,
              text: `benchmark outcome ${i + 1} for session ${sid}`,
            }),
          });
        }
      }
      return { kind: "tools", calls };
    }
    const pad = "Benchmark task complete. All scripted turns executed. ";
    let text = pad.repeat(Math.ceil(params.finalBytes / pad.length)).slice(0, params.finalBytes);
    if (text.length === 0) text = "Done.";
    return { kind: "text", text };
  }

  /** Summarize/compaction response: echo the directive so it survives compaction. */
  function summarizeText(directiveText) {
    return (
      "Summary of prior work: the agent executed a scripted benchmark tool loop. " +
      "Continue following the benchmark directive exactly as before. " +
      (directiveText ?? "")
    );
  }

  const USAGE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };

  // ── Responses API encoding ─────────────────────────────────────────────────

  function respondResponsesJson(res, decision, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = `resp_${Math.random().toString(36).slice(2, 10)}`;
    const output = [];
    if (decision.kind === "tools") {
      for (const call of decision.calls) {
        output.push({
          type: "function_call",
          id: `fc_${call.id}`,
          call_id: call.id,
          name: call.name,
          arguments: call.args,
        });
      }
    } else {
      output.push({
        type: "message",
        role: "assistant",
        id: `msg_${id}`,
        content: [{ type: "output_text", text: decision.text, annotations: [] }],
      });
    }
    const payload = {
      id,
      object: "response",
      created_at: created,
      model,
      output,
      usage: { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens },
      incomplete_details: null,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  function respondResponsesStream(res, decision, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = `resp_${Math.random().toString(36).slice(2, 10)}`;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj) => {
      res.write(`event: ${obj.type}\n`);
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    send({ type: "response.created", response: { id, created_at: created, model } });

    if (decision.kind === "tools") {
      decision.calls.forEach((call, idx) => {
        const itemId = `fc_${call.id}`;
        send({
          type: "response.output_item.added",
          output_index: idx,
          item: { type: "function_call", id: itemId, call_id: call.id, name: call.name, arguments: "" },
        });
        // Split arguments to exercise the streaming delta path
        const mid = Math.max(1, Math.floor(call.args.length / 2));
        send({
          type: "response.function_call_arguments.delta",
          item_id: itemId,
          output_index: idx,
          delta: call.args.slice(0, mid),
        });
        send({
          type: "response.function_call_arguments.delta",
          item_id: itemId,
          output_index: idx,
          delta: call.args.slice(mid),
        });
        send({
          type: "response.output_item.done",
          output_index: idx,
          item: {
            type: "function_call",
            id: itemId,
            call_id: call.id,
            name: call.name,
            arguments: call.args,
            status: "completed",
          },
        });
      });
    } else {
      const msgId = `msg_${id}`;
      send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId } });
      // Chunk the text in ~1KB deltas
      for (let i = 0; i < decision.text.length; i += 1024) {
        send({
          type: "response.output_text.delta",
          item_id: msgId,
          delta: decision.text.slice(i, i + 1024),
        });
      }
      send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: msgId } });
    }

    send({
      type: "response.completed",
      response: {
        usage: { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens },
      },
    });
    res.end();
  }

  // ── Chat Completions encoding ──────────────────────────────────────────────

  function respondChatJson(res, decision, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
    const message = { role: "assistant", content: decision.kind === "text" ? decision.text : null };
    if (decision.kind === "tools") {
      message.tool_calls = decision.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.args },
      }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: decision.kind === "tools" ? "tool_calls" : "stop",
          },
        ],
        usage: USAGE,
      }),
    );
  }

  function respondChatStream(res, decision, model, includeUsage) {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (choices, extra = {}) => {
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`,
      );
    };

    send([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);

    if (decision.kind === "tools") {
      decision.calls.forEach((call, idx) => {
        // First chunk of a tool call carries id + name; arguments stream after.
        send([
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: idx, id: call.id, type: "function", function: { name: call.name, arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ]);
        const mid = Math.max(1, Math.floor(call.args.length / 2));
        for (const piece of [call.args.slice(0, mid), call.args.slice(mid)]) {
          send([
            {
              index: 0,
              delta: { tool_calls: [{ index: idx, function: { arguments: piece } }] },
              finish_reason: null,
            },
          ]);
        }
      });
      send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
    } else {
      for (let i = 0; i < decision.text.length; i += 1024) {
        send([{ index: 0, delta: { content: decision.text.slice(i, i + 1024) }, finish_reason: null }]);
      }
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
    }

    if (includeUsage) send([], { usage: USAGE });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  // ── Main completion handler (shared by both endpoints) ────────────────────

  async function handleCompletion(body, endpoint, res, rawJson) {
    const rawText = extractText(body);
    let directive = parseDirective(rawText);

    // Directive missing (e.g. compacted away) → recover sid from call ids.
    let sid = directive?.sid ?? scanCallIds(rawJson)?.sid ?? null;
    if (!directive && sid && sessions.has(sid)) {
      directive = { sid, ...sessions.get(sid).params };
    }

    if (!directive) {
      // Unknown session — answer benignly so the runtime doesn't crash.
      pushDebug({ at: new Date().toISOString(), endpoint, note: "no-directive", stream: !!body.stream });
      const decision = { kind: "text", text: "bench-mock: no BENCH directive found in context." };
      return encode(body, endpoint, res, decision);
    }

    sid = directive.sid;
    const { sid: _sid, ...params } = directive;
    const session = getSession(sid, params);
    const stats = session.stats;
    const now = new Date().toISOString();
    stats.requests++;
    stats.firstRequestAt ??= now;
    stats.lastRequestAt = now;
    stats.byEndpoint[endpoint]++;
    if (body.stream) stats.streamRequests++;
    else stats.jsonRequests++;

    // Artificial model latency (the "LLM think time" this benchmark subtracts out)
    if (params.latencyMs > 0) {
      await sleep(params.latencyMs);
      stats.llmBusyMs += params.latencyMs;
    }

    // History observability: highest bench call-id turn present in the
    // INCOMING request (echoed/seeded conversation history).
    const scannedHistory = scanCallIds(rawJson);
    if (scannedHistory && scannedHistory.maxTurn > stats.maxHistoryTurn) {
      stats.maxHistoryTurn = scannedHistory.maxTurn;
    }

    let decision;
    if (!hasTools(body)) {
      // Tool-less request ⇒ summarize/utility call (e.g. context compaction).
      // Echo the directive so it survives history replacement.
      stats.summarizeCalls++;
      decision = { kind: "text", text: summarizeText(rawText.match(/\[BENCH[^\]]+\]/)?.[0]) };
    } else {
      const turn = computeTurn(body, rawJson);
      stats.turnRequests[turn] = (stats.turnRequests[turn] ?? 0) + 1;
      decision = decide(sid, params, turn);
      if (decision.kind === "tools") {
        stats.turnsServed = Math.max(stats.turnsServed, turn);
        for (const call of decision.calls) {
          if (call.name === "register_outcome") stats.outcomeCallsEmitted++;
          else stats.toolCallsEmitted++;
        }
      } else {
        stats.turnsServed = Math.max(stats.turnsServed, turn);
        stats.finals++;
      }
      pushDebug({
        at: now,
        endpoint,
        sid,
        turn,
        stream: !!body.stream,
        kind: decision.kind,
        calls: decision.kind === "tools" ? decision.calls.length : 0,
      });
    }

    encode(body, endpoint, res, decision);
  }

  function encode(body, endpoint, res, decision) {
    const model = body.model ?? "mock-1";
    if (endpoint === "responses") {
      if (body.stream) respondResponsesStream(res, decision, model);
      else respondResponsesJson(res, decision, model);
    } else {
      if (body.stream) respondChatStream(res, decision, model, !!body.stream_options?.include_usage);
      else respondChatJson(res, decision, model);
    }
  }

  // ── HTTP server ────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Introspection endpoints
    if (req.method === "GET" && path.startsWith("/bench/stats/")) {
      const sid = path.slice("/bench/stats/".length);
      const s = sessions.get(sid);
      res.writeHead(s ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(s ? { sid, params: s.params, stats: s.stats } : { error: "unknown sid" }));
      return;
    }
    if (req.method === "GET" && path === "/bench/stats") {
      const all = {};
      for (const [sid, s] of sessions) all[sid] = { params: s.params, stats: s.stats };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(all));
      return;
    }
    if (req.method === "GET" && path === "/bench/debug") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(debugLog));
      return;
    }
    if (req.method === "POST" && path === "/bench/reset") {
      sessions.clear();
      debugLog.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && path === "/bench/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // LLM endpoints — match by path suffix so any baseUrl prefix works
    const endpoint = path.endsWith("/chat/completions")
      ? "chat"
      : path.endsWith("/responses")
        ? "responses"
        : null;
    if (req.method === "POST" && endpoint) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
          return;
        }
        handleCompletion(body, endpoint, res, raw).catch((err) => {
          if (!quiet) console.error("[mock-llm] handler error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
          } else {
            res.end();
          }
        });
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `mock-llm: no route for ${req.method} ${path}` } }));
  });

  return {
    server,
    sessions,
    start: () =>
      new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(port, host, () => {
          server.off("error", rejectStart);
          if (!quiet) console.log(`[mock-llm] listening on http://${host}:${port}`);
          resolveStart({ url: `http://${host}:${port}` });
        });
      }),
    stop: () =>
      new Promise((resolveStop) => {
        server.closeAllConnections?.();
        server.close(() => resolveStop());
      }),
  };
}

// ── Standalone CLI: node bench/mock-llm.mjs [--port 8377] [--host 127.0.0.1] ──

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(getArg("port", 8377));
  const host = getArg("host", "127.0.0.1");
  const mock = createMockLlm({ port, host, quiet: false });
  mock.start().catch((err) => {
    console.error("[mock-llm] failed to start:", err.message);
    process.exit(1);
  });
  process.on("SIGINT", () => mock.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => mock.stop().then(() => process.exit(0)));
}
