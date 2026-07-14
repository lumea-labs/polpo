"use client";

import { Fragment, useState, type ReactNode } from "react";
import {
  type ColumnDef,
  type SortingState,
  type FilterFn,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  MagnifyingGlass,
  CaretUp,
  CaretDown,
  CaretUpDown,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react/dist/ssr";
import { useDashboardHost } from "../../host.js";

/** Per-column presentation hints, read off `columnDef.meta`. */
export type ColumnMeta = {
  align?: "left" | "right" | "center";
  headerClassName?: string;
  cellClassName?: string;
  /** Fixed pixel width for this column. */
  width?: number;
};

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  /** Stable row id — defaults to index. */
  getRowId?: (row: T) => string;
  /** Whole-row navigation target. Rows become clickable when provided. */
  rowHref?: (row: T) => string;
  /** Whole-row action for in-page navigation. */
  rowOnClick?: (row: T) => void;
  /** Optional expanded row renderer, displayed directly below the matching row. */
  renderExpandedRow?: (row: T) => ReactNode;
  /** Whether a row should render its expanded content. */
  isRowExpanded?: (row: T) => boolean;
  /** Inline search box. Omit to hide. */
  searchPlaceholder?: string;
  /** Custom matcher for the search box. Defaults to substring over all cells. */
  searchFn?: (row: T, query: string) => boolean;
  /** Inline filter controls, rendered after the search box. */
  filters?: ReactNode;
  /** Right-aligned toolbar slot (e.g. a refresh control). */
  rightSlot?: ReactNode;
  pageSize?: number;
  initialSorting?: SortingState;
  /** Empty state when there is no data at all. */
  empty?: ReactNode;
  /** Empty state when filters/search exclude everything. */
  emptyFiltered?: ReactNode;
};

export function DataTable<T>({
  columns,
  data,
  getRowId,
  rowHref,
  rowOnClick,
  renderExpandedRow,
  isRowExpanded,
  searchPlaceholder,
  searchFn,
  filters,
  rightSlot,
  pageSize = 12,
  initialSorting = [],
  empty,
  emptyFiltered,
}: DataTableProps<T>) {
  const host = useDashboardHost();
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");

  const globalFilterFn: FilterFn<T> = (row, _columnId, value) => {
    const q = String(value).trim().toLowerCase();
    if (!q) return true;
    if (searchFn) return searchFn(row.original, q);
    return Object.values(row.original as Record<string, unknown>).some((v) =>
      String(v ?? "").toLowerCase().includes(q),
    );
  };

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const showToolbar = searchPlaceholder || filters || rightSlot;
  const showPagination = table.getPageCount() > 1;

  return (
    <div className="flex flex-col gap-3">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder && (
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 w-56 rounded-md border border-border bg-transparent pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring/50 focus:outline-none"
              />
            </div>
          )}
          {filters}
          <div className="ml-auto flex items-center gap-3">{rightSlot}</div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border">
                  {hg.headers.map((header) => {
                    const meta = header.column.columnDef.meta as
                      | ColumnMeta
                      | undefined;
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        style={meta?.width ? { width: meta.width } : undefined}
                        className={`bg-muted/40 px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground ${
                          meta?.align === "right"
                            ? "text-right"
                            : meta?.align === "center"
                              ? "text-center"
                              : "text-left"
                        } ${meta?.headerClassName ?? ""}`}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                              meta?.align === "right"
                                ? "flex-row-reverse"
                                : ""
                            }`}
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            {sorted === "asc" ? (
                              <CaretUp size={11} weight="bold" className="text-foreground" />
                            ) : sorted === "desc" ? (
                              <CaretDown size={11} weight="bold" className="text-foreground" />
                            ) : (
                              <CaretUpDown size={11} className="text-muted-foreground/40" />
                            )}
                          </button>
                        ) : (
                          flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.map((row) => {
                const href = rowHref?.(row.original);
                const clickable = !!href || !!rowOnClick;
                const expanded = renderExpandedRow && isRowExpanded?.(row.original);
                return (
                  <Fragment key={row.id}>
                    <tr
                      data-row
                      onClick={
                        clickable
                          ? () => {
                              if (href) {
                                host.navigate(href);
                              } else rowOnClick?.(row.original);
                            }
                          : undefined
                      }
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key !== "Enter") return;
                              if (href) {
                                host.navigate(href);
                              } else rowOnClick?.(row.original);
                            }
                          : undefined
                      }
                      tabIndex={clickable ? 0 : undefined}
                      className={`group border-b border-border transition-colors ${
                        clickable ? "cursor-pointer hover:bg-secondary/50" : ""
                      } ${expanded ? "bg-secondary/30" : ""}`}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta as
                          | ColumnMeta
                          | undefined;
                        return (
                          <td
                            key={cell.id}
                            className={`min-w-0 px-3.5 py-2.5 align-middle ${
                              meta?.align === "right"
                                ? "text-right"
                                : meta?.align === "center"
                                  ? "text-center"
                                  : "text-left"
                            } ${meta?.cellClassName ?? ""}`}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border last:border-0">
                        <td colSpan={columns.length} className="bg-background p-3">
                          {renderExpandedRow(row.original)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-3.5 py-14 text-center">
                    {data.length === 0
                      ? (empty ?? (
                          <span className="text-sm text-muted-foreground">
                            Nothing here yet.
                          </span>
                        ))
                      : (emptyFiltered ?? (
                          <span className="text-sm text-muted-foreground">
                            No matches.
                          </span>
                        ))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {showPagination && (
          <div className="flex items-center justify-between border-t border-border px-3.5 py-2">
            <span className="text-xs text-muted-foreground" data-tabular>
              {table.getState().pagination.pageIndex * pageSize + 1}–
              {Math.min(
                (table.getState().pagination.pageIndex + 1) * pageSize,
                filteredCount,
              )}{" "}
              of {filteredCount}
            </span>
            <div className="flex items-center gap-1">
              <PagerButton
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
                label="Previous page"
              >
                <CaretLeft size={13} />
              </PagerButton>
              <PagerButton
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
                label="Next page"
              >
                <CaretRight size={13} />
              </PagerButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PagerButton({
  children,
  disabled,
  onClick,
  label,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
