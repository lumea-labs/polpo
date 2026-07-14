// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type ColumnMeta } from "./components.js";
import { DashboardProvider, useDashboardHost } from "./host.js";

type Row = { id: string; name: string; detail: string };

const api = {
  fetchDataPlane: async <T,>() => ({}) as T,
  mutateDataPlane: async <T,>() => ({}) as T,
  fetchControlPlane: async <T,>() => ({}) as T,
  mutateControlPlane: async <T,>() => ({}) as T,
  controlPlaneBaseUrl: () => "",
  dataPlaneBaseUrl: () => "/api/polpo",
  runtimeUrl: (_projectId: string, path: string) => path,
};

afterEach(cleanup);

const columns: ColumnDef<Row, unknown>[] = [
  { id: "name", header: "Name", accessorKey: "name" },
  {
    id: "detail",
    header: "Detail",
    accessorKey: "detail",
    meta: { hideOnMobile: true } satisfies ColumnMeta,
  },
];

function renderTable(navigate = vi.fn()) {
  render(
    <DashboardProvider host={{ project: { id: "local" }, api, navigate }}>
      <DataTable
        columns={columns}
        data={[
          { id: "one", name: "Alpha", detail: "First" },
          { id: "two", name: "Beta", detail: "Second" },
        ]}
        getRowId={(row) => row.id}
        rowHref={(row) => `/rows/${row.id}`}
        searchPlaceholder="Search rows..."
        searchFn={(row, query) => row.name.toLowerCase().includes(query)}
      />
    </DashboardProvider>,
  );
  return navigate;
}

describe("DataTable", () => {
  it("delegates row navigation to the dashboard host", () => {
    const navigate = renderTable();
    fireEvent.click(screen.getByText("Alpha"));
    expect(navigate).toHaveBeenCalledWith("/rows/one");
  });

  it("filters rows through the view-provided search function", () => {
    renderTable();
    fireEvent.change(screen.getByPlaceholderText("Search rows..."), {
      target: { value: "beta" },
    });
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("marks secondary headers and cells for compact layouts", () => {
    renderTable();
    expect(screen.getByRole("columnheader", { name: /detail/i })).toHaveAttribute(
      "data-mobile-hidden",
      "true",
    );
    expect(screen.getByText("First").closest("td")).toHaveAttribute(
      "data-mobile-hidden",
      "true",
    );
  });
});

describe("DashboardProvider", () => {
  it("exposes managed component slots to shared views", () => {
    function ManagedChat() {
      return <div>Managed chat</div>;
    }

    function SlotProbe() {
      const Chat = useDashboardHost().components?.AgentRunChat;
      return Chat ? <Chat baseUrl="/runtime" agent="support" /> : null;
    }

    render(
      <DashboardProvider
        host={{
          project: { id: "cloud" },
          api,
          navigate: vi.fn(),
          components: { AgentRunChat: ManagedChat },
        }}
      >
        <SlotProbe />
      </DashboardProvider>,
    );

    expect(screen.getByText("Managed chat")).toBeInTheDocument();
  });
});
