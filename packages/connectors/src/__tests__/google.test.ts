import { describe, expect, it, vi } from "vitest";
import { createConnectorRegistry, resolveConnectorHttpRequest } from "@polpo-ai/connect";
import { executeGoogleAction, gmailDefinition, googleDriveDefinition, type GoogleActionGateway } from "../google.js";

function gateway(responses: unknown[]) {
  return vi.fn<GoogleActionGateway>(async () => ({ status: 200, headers: {}, body: responses.shift() }));
}

describe("Google agent integrations", () => {
  it("declares read-only API capabilities without OAuth client credentials", () => {
    const registry = createConnectorRegistry([gmailDefinition, googleDriveDefinition]);
    expect(registry.catalog().map((entry) => [entry.id, entry.protocol])).toEqual([["gmail", "http_api"], ["google_drive", "http_api"]]);
    for (const provider of registry.list()) {
      expect(provider.http?.allowedMethods).toEqual(["GET"]);
      expect(() => resolveConnectorHttpRequest(provider.http!, { method: "POST", path: "/gmail/v1/users/me/messages/send" })).toThrow();
      expect(JSON.stringify(provider)).not.toMatch(/clientSecret|clientId|accessToken|refreshToken/);
    }
  });

  it("searches the authenticated Gmail account with bounded pagination", async () => {
    const request = gateway([{ messages: [{ id: "message1", threadId: "thread1" }], nextPageToken: "next" }]);
    const result = await executeGoogleAction("gmail_search_messages", { query: "is:unread", pageSize: 20, pageToken: "previous" }, { request });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "gmail_search_messages", scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      request: { method: "GET", path: "/gmail/v1/users/me/messages", query: { q: "is:unread", maxResults: "20", pageToken: "previous" } },
    }));
    expect(result).toEqual({ messages: [{ id: "message1", threadId: "thread1" }], nextPageToken: "next" });
  });

  it("reads MIME text and attachment metadata without downloading attachments", async () => {
    const request = gateway([{
      id: "message1", threadId: "thread1", snippet: "hello",
      payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "A subject" }], parts: [
        { mimeType: "text/plain", body: { data: "SGVsbG8gV29ybGQ" } },
        { mimeType: "application/pdf", filename: "example.pdf", body: { attachmentId: "attachment1", size: 123 } },
      ] },
    }]);
    expect(await executeGoogleAction("gmail_read_message", { messageId: "message1" }, { request })).toMatchObject({
      id: "message1", text: "Hello World", subject: "A subject", attachments: [{ id: "attachment1", filename: "example.pdf", mimeType: "application/pdf", size: 123 }],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes the shared Drive flags and a continuation token", async () => {
    const request = gateway([{ files: [{ id: "file1", driveId: "shared1" }], nextPageToken: "next", incompleteSearch: false }]);
    expect(await executeGoogleAction("drive_search_files", { driveId: "shared1", pageToken: "previous" }, { request }))
      .toMatchObject({ files: [{ id: "file1", driveId: "shared1" }], nextPageToken: "next" });
    expect(request.mock.calls[0][0].request.query).toMatchObject({
      supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "drive", driveId: "shared1", pageToken: "previous",
    });
  });

  it("treats null optional search inputs as omitted without losing a selected shared drive", async () => {
    const request = gateway([{ files: [] }, { messages: [] }]);
    await executeGoogleAction("drive_search_files", { query: null, driveId: "shared1", pageSize: null, pageToken: null }, { request });
    expect(request.mock.calls[0][0].request.query).toMatchObject({ corpora: "drive", driveId: "shared1", pageSize: "20" });
    expect(request.mock.calls[0][0].request.query).toHaveProperty("q", "trashed = false");
    expect(request.mock.calls[0][0].request.query).not.toHaveProperty("pageToken");
    await executeGoogleAction("gmail_search_messages", { query: "in:drafts", pageSize: null, pageToken: null }, { request });
    expect(request.mock.calls[1][0].request.query).toEqual({ q: "in:drafts", maxResults: "20" });
  });

  it("accepts null optional read arguments while preserving default export and size limits", async () => {
    const request = gateway([{ id: "file1", mimeType: "application/vnd.google-apps.document" }, "Hello"]);
    expect(await executeGoogleAction("drive_read_file", { fileId: "file1", mimeType: null, maxChars: null }, { request }))
      .toMatchObject({ content: "Hello", truncated: false });
    expect(request.mock.calls[1][0].request.query).toEqual({ mimeType: "text/plain" });
  });

  it("reads a shared Google document through metadata and a bounded export", async () => {
    const request = gateway([{ id: "file1", mimeType: "application/vnd.google-apps.document", name: "Notes", driveId: "shared1" }, "Hello World"]);
    expect(await executeGoogleAction("drive_read_file", { fileId: "file1", maxChars: 5 }, { request }))
      .toMatchObject({ content: "Hello", truncated: true });
    expect(request.mock.calls[0][0].request.query).toMatchObject({ supportsAllDrives: "true" });
    expect(request.mock.calls[1][0].request).toMatchObject({ path: "/drive/v3/files/file1/export", query: { mimeType: "text/plain" } });
  });

  it.each([
    ["gmail_search_messages", { userId: "somebody-else" }],
    ["gmail_search_messages", { pageSize: 501 }],
    ["gmail_read_message", { messageId: "../profile" }],
    ["drive_read_file", { fileId: "file1?alt=media" }],
    ["drive_search_files", { pageSize: -1 }],
    ["drive_search_files", { driveId: " " }],
    ["drive_search_files", { unknown: null }],
    ["drive_read_file", { fileId: null }],
    ["gmail_read_message", { messageId: null }],
    ["drive_send_file", {}],
  ])("rejects malformed or unsupported %s input before provider access", async (action, args) => {
    const request = gateway([]);
    await expect(executeGoogleAction(action as string, args, { request })).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns provider denials without leaking the body or trying another account", async () => {
    const request = vi.fn<GoogleActionGateway>(async () => ({ status: 403, headers: {}, body: { error: "private-provider-diagnostic" } }));
    const error = await executeGoogleAction("gmail_search_messages", {}, { request }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", details: { providerStatus: 403 } });
    expect(JSON.stringify(error)).not.toContain("private-provider-diagnostic");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed provider payloads", async () => {
    await expect(executeGoogleAction("drive_search_files", {}, { request: gateway([{ files: "unexpected" }]) }))
      .rejects.toMatchObject({ code: "http_error" });
  });
});
