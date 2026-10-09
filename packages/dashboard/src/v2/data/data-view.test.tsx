// @vitest-environment jsdom

import "../../test/setup.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardProvider } from "../../host.js";
import { TooltipProvider } from "../ui/tooltip.js";
const mocks = vi.hoisted(() => ({
  listData: vi.fn(), createData: vi.fn(), query: vi.fn(), transaction: vi.fn(), migrateSql: vi.fn(), migrations: vi.fn(), rename: vi.fn(), remove: vi.fn(), migrate: vi.fn(),
}));
vi.mock("@polpo-ai/react", () => ({ usePolpo: () => ({ client: { ...mocks, data: () => mocks } }) }));
vi.mock("../ui/code-editor.js", () => ({ CodeEditor: ({ value, onChange, ariaLabel }: any) => <textarea aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)} /> }));
import { DataView } from "./data-view.js";

const resource = { id: "11111111-1111-4111-8111-111111111111", name: "crm", schemaVersion: 1, createdAt: "2026-10-09T00:00:00Z", schema: { tables: { contacts: { columns: { name: { type: "text" } } } } } };
const row = { _id: "22222222-2222-4222-8222-222222222222", _version: 1, name: "Ada", _created_at: "2026-10-09T00:00:00Z", _updated_at: "2026-10-09T00:00:00Z" };
let client: QueryClient;
function show(enabled = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<DashboardProvider host={{ project: { id: "local" }, navigate: vi.fn() }}><QueryClientProvider client={client}><TooltipProvider><DataView projectId="local" enabled={enabled} /></TooltipProvider></QueryClientProvider></DashboardProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listData.mockResolvedValue([resource]);
  mocks.transaction.mockResolvedValue([{ rows: [row], total: 1, nextOffset: null }]);
  mocks.query.mockResolvedValue({ rows: [{ total: 1 }], rowCount: 1, truncated: false });
  mocks.migrations.mockResolvedValue([]);
});
afterEach(() => { cleanup(); client?.clear(); });

describe("self-hosted Data dashboard through the SDK", () => {
  it("loads tables and records without managed-only controls", async () => {
    show();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Schema" })).toHaveTextContent("crm");
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Access" })).not.toBeInTheDocument();
  });
  it("keeps disabled hosts from sending requests", () => {
    show(false);
    expect(screen.getByText("Databases are not enabled on this runtime")).toBeInTheDocument();
    expect(mocks.listData).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create database" })).toBeDisabled();
  });
  it("shows unavailable backend errors instead of an empty successful catalog", async () => {
    mocks.listData.mockRejectedValue(Object.assign(new Error("Data unavailable"), { status: 503 }));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("administrator");
    expect(screen.getByRole("button", { name: "Create database" })).toBeDisabled();
  });
  it("explains a runtime without the Data route", async () => {
    mocks.listData.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Databases are not configured");
    expect(screen.getByRole("button", { name: "Create database" })).toBeDisabled();
  });
  it("creates a schema through the configured SDK client", async () => {
    mocks.listData.mockResolvedValue([]);
    mocks.createData.mockImplementation(async () => { mocks.listData.mockResolvedValue([resource]); return resource; });
    show();
    await screen.findByText("Your first database");
    fireEvent.click(screen.getByRole("button", { name: "Create database" }));
    fireEvent.change(screen.getByPlaceholderText("crm"), { target: { value: "crm" } });
    fireEvent.change(screen.getByLabelText("Table schema (JSON)"), { target: { value: JSON.stringify(resource.schema) } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create database" }).at(-1)!);
    await waitFor(() => expect(mocks.createData).toHaveBeenCalledWith({ name: "crm", schema: resource.schema }));
    expect(await screen.findByText("Ada")).toBeInTheDocument();
  });
  it("runs SQL with parameters and retains failures visibly", async () => {
    show(); await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("tab", { name: "Query" }));
    fireEvent.change(screen.getByLabelText("SQL"), { target: { value: "SELECT $1 AS total" } });
    fireEvent.change(screen.getByLabelText("Parameters (JSON array)"), { target: { value: "[1]" } });
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith({ sql: "SELECT $1 AS total", params: [1], mode: "read", maxRows: 50 }));
    await screen.findByText(/rows shown/);
    mocks.query.mockRejectedValueOnce(new Error("Query denied"));
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Query denied");
  });
  it("keeps a failed migration editable and retries the identical migration", async () => {
    mocks.migrateSql.mockRejectedValueOnce(new Error("409 Schema version conflict")).mockResolvedValueOnce({ ...resource, schemaVersion: 2 });
    show(); await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("tab", { name: "Migrations" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply migration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Schema version conflict");
    fireEvent.click(screen.getByRole("button", { name: "Apply migration" }));
    await screen.findByText("Migration applied · schema v2");
    expect(mocks.migrateSql.mock.calls[0]).toEqual(mocks.migrateSql.mock.calls[1]);
  });
  it("returns from an invalid last page after another client deletes its only row", async () => {
    let total = 26;
    mocks.transaction.mockImplementation(async ([op]) => [{ rows: op.offset === 25 ? (total === 26 ? [{ ...row, name: "Last" }] : []) : [row], total, nextOffset: op.offset === 0 && total > 25 ? 25 : null }]);
    show(); await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Last");
    total = 25;
    await act(async () => { await client.invalidateQueries({ queryKey: ["data-records"] }); });
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());
    expect(mocks.transaction).toHaveBeenLastCalledWith([{ op: "list", table: "contacts", limit: 25, offset: 0 }], { idempotencyKey: undefined });
  });
});
