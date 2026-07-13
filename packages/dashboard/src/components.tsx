"use client";

import {
  Fragment,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretUpDown,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type FilterFn,
  type SortingState,
} from "@tanstack/react-table";
import { useDashboardHost } from "./host.js";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="pd-page-header">
      <div className="pd-min-w-0">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="pd-actions">{actions}</div> : null}
    </div>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="pd-page-body">{children}</div>;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      className={`pd-button pd-button-${variant} ${className}`.trim()}
    />
  );
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button {...props} type={props.type ?? "button"} className="pd-icon-button" aria-label={label} title={label}>
      {children}
    </button>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="pd-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="pd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="pd-modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="pd-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="pd-loading-rows" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} />
      ))}
    </div>
  );
}

export type ColumnMeta = {
  align?: "left" | "right" | "center";
  width?: number;
  cellClassName?: string;
  hideOnMobile?: boolean;
};

export function DataTable<T>({
  columns,
  data,
  getRowId,
  rowHref,
  onRowClick,
  searchPlaceholder,
  searchFn,
  rightSlot,
  filters,
  empty,
  pageSize = 12,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId?: (row: T) => string;
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  searchPlaceholder?: string;
  searchFn?: (row: T, query: string) => boolean;
  rightSlot?: ReactNode;
  filters?: ReactNode;
  empty?: ReactNode;
  pageSize?: number;
}) {
  const host = useDashboardHost();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const globalFilterFn: FilterFn<T> = (row, _column, value) => {
    const query = String(value).trim().toLowerCase();
    if (!query) return true;
    if (searchFn) return searchFn(row.original, query);
    return Object.values(row.original as Record<string, unknown>).some((item) =>
      String(item ?? "").toLowerCase().includes(query),
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
  const filtered = table.getFilteredRowModel().rows.length;

  return (
    <div className="pd-table-stack">
      {searchPlaceholder || filters || rightSlot ? (
        <div className="pd-table-toolbar">
          {searchPlaceholder ? (
            <div className="pd-search">
              <MagnifyingGlass size={14} />
              <input
                value={globalFilter}
                onChange={(event) => setGlobalFilter(event.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
          ) : null}
          {filters}
          <div className="pd-table-toolbar-right">{rightSlot}</div>
        </div>
      ) : null}
      <div className="pd-table-frame">
        <div className="pd-table-scroll">
          <table>
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta as ColumnMeta | undefined;
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        style={meta?.width ? { width: meta.width } : undefined}
                        data-align={meta?.align}
                        data-mobile-hidden={meta?.hideOnMobile ? "true" : undefined}
                      >
                        {header.column.getCanSort() ? (
                          <button type="button" onClick={header.column.getToggleSortingHandler()}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? <CaretUp size={11} /> : sorted === "desc" ? <CaretDown size={11} /> : <CaretUpDown size={11} />}
                          </button>
                        ) : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.map((row) => {
                const href = rowHref?.(row.original);
                const clickable = Boolean(href || onRowClick);
                const openRow = () => {
                  if (href) host.navigate(href);
                  else onRowClick?.(row.original);
                };
                return (
                  <Fragment key={row.id}>
                    <tr
                      data-clickable={clickable ? "true" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? openRow : undefined}
                      onKeyDown={clickable ? (event) => event.key === "Enter" && openRow() : undefined}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
                        return (
                          <td
                            key={cell.id}
                            data-align={meta?.align}
                            data-mobile-hidden={meta?.hideOnMobile ? "true" : undefined}
                            className={meta?.cellClassName}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                );
              })}
              {rows.length === 0 ? (
                <tr><td className="pd-empty-cell" colSpan={columns.length}>{empty ?? "Nothing here yet."}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {table.getPageCount() > 1 ? (
          <div className="pd-pagination">
            <span>{table.getState().pagination.pageIndex * pageSize + 1}-{Math.min((table.getState().pagination.pageIndex + 1) * pageSize, filtered)} of {filtered}</span>
            <div>
              <IconButton label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><CaretLeft size={13} /></IconButton>
              <IconButton label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}><CaretRight size={13} /></IconButton>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function useStableColumns<T>(factory: () => ColumnDef<T, unknown>[], deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
