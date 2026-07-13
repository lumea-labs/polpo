import { createServer } from "node:http";

const encoder = new TextEncoder();

function responseObject() {
  return {
    id: `resp_${Date.now()}`,
    created_at: Math.floor(Date.now() / 1000),
    model: "e2e-model",
    output: [{
      type: "message",
      role: "assistant",
      id: `msg_${Date.now()}`,
      content: [{
        type: "output_text",
        text: "Self-hosted Polpo is operational.",
        annotations: [],
      }],
    }],
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = responseObject();

  if (input.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const events = [
      { type: "response.output_item.added", output_index: 0, item: result.output[0], sequence_number: 1 },
      { type: "response.content_part.added", item_id: result.output[0].id, output_index: 0, content_index: 0, part: result.output[0].content[0], sequence_number: 2 },
      { type: "response.output_text.delta", item_id: result.output[0].id, output_index: 0, content_index: 0, delta: result.output[0].content[0].text, sequence_number: 3 },
      { type: "response.output_text.done", item_id: result.output[0].id, output_index: 0, content_index: 0, text: result.output[0].content[0].text, sequence_number: 4 },
      { type: "response.content_part.done", item_id: result.output[0].id, output_index: 0, content_index: 0, part: result.output[0].content[0], sequence_number: 5 },
      { type: "response.output_item.done", output_index: 0, item: result.output[0], sequence_number: 6 },
      { type: "response.completed", response: result, sequence_number: 7 },
    ];
    for (const event of events) response.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    response.write(encoder.encode("data: [DONE]\n\n"));
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
});

server.listen(4010, "0.0.0.0", () => console.log("Mock LLM listening on :4010"));
