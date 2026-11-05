import { describe, expect, it, vi } from "vitest";
import { type ConnectorActionGateway } from "@polpo-ai/connect";
import { createConnectorContributionRegistry } from "../../contribution.js";
import { googleDriveContribution } from "./index.js";

const registry = createConnectorContributionRegistry([googleDriveContribution]);
const gateway = (responses: unknown[]) => vi.fn<ConnectorActionGateway>(async () => ({
  status: 200,
  headers: {},
  body: responses.shift(),
}));

describe("Google Drive Connector contribution", () => {
  it("includes shared-drive flags and a continuation token", async () => {
    const request = gateway([{
      files: [{ id: "file1", driveId: "shared1" }],
      nextPageToken: "next",
      incompleteSearch: false,
    }]);
    await expect(registry.execute("drive_search_files", {
      driveId: "shared1", pageToken: "previous",
    }, { request })).resolves.toMatchObject({
      files: [{ id: "file1", driveId: "shared1" }],
      nextPageToken: "next",
    });
    expect(request.mock.calls[0]![0].request.query).toMatchObject({
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "drive",
      driveId: "shared1",
      pageToken: "previous",
    });
  });

  it("treats null optional search inputs as omitted without losing a shared drive", async () => {
    const request = gateway([{ files: [] }]);
    await registry.execute("drive_search_files", {
      query: null, driveId: "shared1", pageSize: null, pageToken: null,
    }, { request });
    expect(request.mock.calls[0]![0].request.query).toMatchObject({
      corpora: "drive", driveId: "shared1", pageSize: "20", q: "trashed = false",
    });
    expect(request.mock.calls[0]![0].request.query).not.toHaveProperty("pageToken");
  });

  it("accepts null optional read arguments while preserving defaults", async () => {
    const request = gateway([
      { id: "file1", mimeType: "application/vnd.google-apps.document" },
      "Hello",
    ]);
    await expect(registry.execute("drive_read_file", {
      fileId: "file1", mimeType: null, maxChars: null,
    }, { request })).resolves.toMatchObject({ content: "Hello", truncated: false });
    expect(request.mock.calls[1]![0].request.query).toEqual({ mimeType: "text/plain" });
  });

  it("reads a shared document through metadata and a bounded export", async () => {
    const request = gateway([
      {
        id: "file1",
        mimeType: "application/vnd.google-apps.document",
        name: "Notes",
        driveId: "shared1",
      },
      "Hello World",
    ]);
    await expect(registry.execute("drive_read_file", {
      fileId: "file1", maxChars: 5,
    }, { request })).resolves.toMatchObject({ content: "Hello", truncated: true });
    expect(request.mock.calls[0]![0].request.query).toMatchObject({ supportsAllDrives: "true" });
    expect(request.mock.calls[1]![0].request).toMatchObject({
      path: "/drive/v3/files/file1/export",
      query: { mimeType: "text/plain" },
    });
  });

  it.each([
    ["drive_read_file", { fileId: "file1?alt=media" }],
    ["drive_search_files", { pageSize: -1 }],
    ["drive_search_files", { driveId: " " }],
    ["drive_search_files", { unknown: null }],
    ["drive_read_file", { fileId: null }],
  ])("rejects malformed %s input before provider access", async (action, input) => {
    const request = gateway([]);
    await expect(registry.execute(action, input, { request }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed provider payloads", async () => {
    await expect(registry.execute("drive_search_files", {}, {
      request: gateway([{ files: "unexpected" }]),
    })).rejects.toMatchObject({ code: "http_error" });
  });
});
