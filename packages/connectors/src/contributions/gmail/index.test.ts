import { describe, expect, it, vi } from "vitest";
import { type ConnectorActionGateway } from "@polpo-ai/connect";
import { createConnectorContributionRegistry } from "../../contribution.js";
import { gmailContribution } from "./index.js";

const registry = createConnectorContributionRegistry([gmailContribution]);
const gateway = (responses: unknown[]) => vi.fn<ConnectorActionGateway>(async () => ({
  status: 200,
  headers: {},
  body: responses.shift(),
}));

describe("Gmail Connector contribution", () => {
  it("searches the authenticated account with bounded pagination", async () => {
    const request = gateway([{
      messages: [{ id: "message1", threadId: "thread1" }],
      nextPageToken: "next",
    }]);
    await expect(registry.execute("gmail_search_messages", {
      query: "is:unread", pageSize: 20, pageToken: "previous",
    }, { request })).resolves.toEqual({
      messages: [{ id: "message1", threadId: "thread1" }],
      nextPageToken: "next",
    });
    expect(request).toHaveBeenCalledWith({
      actionId: "gmail_search_messages",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      request: {
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        query: { q: "is:unread", maxResults: "20", pageToken: "previous" },
      },
    });
  });

  it("reads MIME text and attachment metadata without downloading attachments", async () => {
    const request = gateway([{
      id: "message1",
      threadId: "thread1",
      snippet: "hello",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "A subject" }],
        parts: [
          { mimeType: "text/plain", body: { data: "SGVsbG8gV29ybGQ" } },
          {
            mimeType: "application/pdf",
            filename: "example.pdf",
            body: { attachmentId: "attachment1", size: 123 },
          },
        ],
      },
    }]);
    await expect(registry.execute("gmail_read_message", {
      messageId: "message1",
    }, { request })).resolves.toMatchObject({
      id: "message1",
      text: "Hello World",
      subject: "A subject",
      attachments: [{
        id: "attachment1",
        filename: "example.pdf",
        mimeType: "application/pdf",
        size: 123,
      }],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats null optional search inputs as omitted", async () => {
    const request = gateway([{ messages: [] }]);
    await registry.execute("gmail_search_messages", {
      query: "in:drafts", pageSize: null, pageToken: null,
    }, { request });
    expect(request.mock.calls[0]![0].request.query)
      .toEqual({ q: "in:drafts", maxResults: "20" });
  });

  it.each([
    ["gmail_search_messages", { userId: "somebody-else" }],
    ["gmail_search_messages", { pageSize: 501 }],
    ["gmail_read_message", { messageId: "../profile" }],
    ["gmail_read_message", { messageId: null }],
  ])("rejects malformed %s input before provider access", async (action, input) => {
    const request = gateway([]);
    await expect(registry.execute(action, input, { request }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns provider denials without leaking the body or trying another account", async () => {
    const request = vi.fn<ConnectorActionGateway>(async () => ({
      status: 403,
      headers: {},
      body: { error: "private-provider-diagnostic" },
    }));
    const error = await registry.execute("gmail_search_messages", {}, { request })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "http_error", details: { providerStatus: 403 } });
    expect(JSON.stringify(error)).not.toContain("private-provider-diagnostic");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
