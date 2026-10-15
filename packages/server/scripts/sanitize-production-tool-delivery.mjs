#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: sanitize-production-tool-delivery.mjs <private-capture.json> <output.json>");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const captureText = await readFile(inputPath, "utf8");
const capture = JSON.parse(captureText);
const delivery = capture.find((entry) =>
  typeof entry?.body === "string" && entry.body.includes('"type":"response.chunk"')
);
if (!delivery) throw new Error("Private capture does not contain a delivery stream");

const aliases = new Map();
const alias = (id) => {
  if (typeof id !== "string" || !id) return undefined;
  if (!aliases.has(id)) aliases.set(id, `call-${aliases.size + 1}`);
  return aliases.get(id);
};
const frames = [];
let startedAt;
for (const line of delivery.body.split(/\r?\n/)) {
  if (!line.startsWith("data: ")) continue;
  const encoded = line.slice(6);
  if (encoded === "[DONE]") continue;
  let event;
  try { event = JSON.parse(encoded); } catch { continue; }
  const createdAt = Date.parse(event.createdAt);
  if (startedAt === undefined && Number.isFinite(createdAt)) startedAt = createdAt;
  const frame = {
    sequence: event.sequence,
    type: event.type,
    ...(Number.isFinite(createdAt) && startedAt !== undefined
      ? { offsetMs: createdAt - startedAt }
      : {}),
  };
  if (event.type === "response.chunk" && typeof event.data?.data === "string") {
    let chunk;
    try { chunk = JSON.parse(event.data.data); } catch { chunk = undefined; }
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    const toolCall = choice?.tool_call;
    const loopTrace = choice?.loop_trace;
    frame.chunk = {
      deltaKeys: delta && typeof delta === "object" ? Object.keys(delta).sort() : [],
      ...(typeof delta?.content === "string" ? { contentBytes: Buffer.byteLength(delta.content) } : {}),
      ...(typeof delta?.reasoning === "string" ? { reasoningBytes: Buffer.byteLength(delta.reasoning) } : {}),
      ...(choice?.finish_reason == null ? {} : { finishReason: choice.finish_reason }),
      ...(toolCall && typeof toolCall === "object" ? {
        toolCall: {
          ...(alias(toolCall.id) ? { id: alias(toolCall.id) } : {}),
          ...(typeof toolCall.name === "string" ? { name: toolCall.name } : {}),
          ...(typeof toolCall.state === "string" ? { state: toolCall.state } : {}),
          argumentKeys: toolCall.arguments && typeof toolCall.arguments === "object"
            ? Object.keys(toolCall.arguments).sort()
            : [],
          ...(typeof toolCall.result === "string" ? {
            resultBytes: Buffer.byteLength(toolCall.result),
            resultKind: toolCall.result.startsWith("Error:") ? "error" : "success",
          } : {}),
        },
      } : {}),
      ...(loopTrace && typeof loopTrace === "object" ? {
        loopTrace: {
          ...(typeof loopTrace.type === "string" ? { type: loopTrace.type } : {}),
          ...(typeof loopTrace.status === "string" ? { status: loopTrace.status } : {}),
          keys: Object.keys(loopTrace).sort(),
        },
      } : {}),
      ...(chunk?.polpo && typeof chunk.polpo === "object"
        ? { polpoKeys: Object.keys(chunk.polpo).sort() }
        : {}),
      ...(choice?.error && typeof choice.error === "object"
        ? { errorCode: choice.error.code ?? "unknown" }
        : {}),
    };
  } else if (event.type === "run.failed") {
    frame.error = { present: typeof event.data?.message === "string" };
  }
  frames.push(frame);
}

const serializedFrames = JSON.stringify(frames);
const output = {
  schemaVersion: 1,
  id: "PROD-TOOL-001-DELIVERY",
  source: {
    privateCaptureSha256: sha256(captureText),
    privateDeliveryBodySha256: sha256(delivery.body),
    sanitizer: "sanitize-production-tool-delivery.mjs@1",
  },
  frameCount: frames.length,
  sanitizedFramesSha256: sha256(serializedFrames),
  frames,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
