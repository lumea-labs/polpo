"use client";

import { SearchInput } from "./search-input.js";
import { Fragment, useState, type ReactNode } from "react";
import { useDashboardHost } from "../../host.js";
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
  CaretUp,
  CaretDown,
  CaretUpDown,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react/dist/ssr";

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
  /** Keep the table within its container instead of allowing horizontal scroll. */
  fitWidth?: boolean;
  pageSize?: number;
  initialSorting?: SortingState;
  /** A server-owned page. Keeps the shared footer without paginating a page again. */
  pagination?: {
    pageIndex: number;
    pageSize: number;
    rowCount: number;
    hasNextPage: boolean;
    disabled?: boolean;
    onPageChange: (pageIndex: number) => void;
  };
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
  fitWidth = false,
  pageSize = 12,
  initialSorting = [],
  pagination,
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
      String(v ?? "")
        .toLowerCase()
        .includes(q),
    );
  };

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter,
      ...(pagination
        ? {
            pagination: {
              pageIndex: pagination.pageIndex,
              pageSize: pagination.pageSize,
            },
          }
        : {}),
    },
    manualPagination: !!pagination,
    rowCount: pagination?.rowCount,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: pagination ? undefined : getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const showToolbar = searchPlaceholder || filters || rightSlot;
  const showPagination = pagination
    ? pagination.rowCount > pagination.pageSize || pagination.pageIndex > 0
    : table.getPageCount() > 1;
  const displayedPageSize = pagination?.pageSize ?? pageSize;
  const totalCount = pagination?.rowCount ?? filteredCount;
  const pageStart = table.getState().pagination.pageIndex * displayedPageSize;

  return (
    <div className="flex flex-col gap-3">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder && (
            <SearchInput
              value={globalFilter}
              onChange={setGlobalFilter}
              placeholder={searchPlaceholder}
            />
          )}
          {filters}
          <div className="ml-auto flex items-center gap-3">{rightSlot}</div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className={fitWidth ? "overflow-hidden" : "overflow-x-auto"}>
          <table
            className={`w-full border-collapse text-sm ${fitWidth ? "table-fixed" : ""}`}
          >
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
                              meta?.align === "right" ? "flex-row-reverse" : ""
                            }`}
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            {sorted === "asc" ? (
                              <CaretUp
                                size={11}
                                weight="bold"
                                className="text-foreground"
                              />
                            ) : sorted === "desc" ? (
                              <CaretDown
                                size={11}
                                weight="bold"
                                className="text-foreground"
                              />
                            ) : (
                              <CaretUpDown
                                size={11}
                                className="text-muted-foreground/40"
                              />
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
                const expanded =
                  renderExpandedRow && isRowExpanded?.(row.original);
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
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border last:border-0">
                        <td
                          colSpan={columns.length}
                          className="bg-background p-3"
                        >
                          {renderExpandedRow(row.original)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3.5 py-14 text-center"
                  >
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
              {rows.length ? pageStart + 1 : 0}–
              {rows.length ? Math.min(pageStart + rows.length, totalCount) : 0} of {totalCount}
            </span>
            <div className="flex items-center gap-1">
              <PagerButton
                disabled={
                  pagination
                    ? pagination.disabled || pagination.pageIndex === 0
                    : !table.getCanPreviousPage()
                }
                onClick={() =>
                  pagination
                    ? pagination.onPageChange(pagination.pageIndex - 1)
                    : table.previousPage()
                }
                label="Previous page"
              >
                <CaretLeft size={13} />
              </PagerButton>
              <PagerButton
                disabled={
                  pagination
                    ? pagination.disabled || !pagination.hasNextPage
                    : !table.getCanNextPage()
                }
                onClick={() =>
                  pagination
                    ? pagination.onPageChange(pagination.pageIndex + 1)
                    : table.nextPage()
                }
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
