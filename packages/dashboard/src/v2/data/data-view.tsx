"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Table,
  Plus,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "../files/host.js";
import type {
  DataResource,
  DataRow,
  DataTable as DataTableSchema,
  DataValue,
} from "@polpo-ai/core/data";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog.js";
import { PageHeader } from "../ui/page-header.js";
import { SelectField } from "../ui/select-field.js";
import { EmptyState, Chip, Section } from "../ui/bits.js";
import { TabBar, SideTabs } from "../ui/tabs.js";
import { DataTable } from "../ui/data-table.js";
import {
  TableRowActions,
  TableRowAction,
} from "../ui/table-row-actions.js";
import { CopyId } from "../ui/copy-id.js";
import { RefreshButton } from "../ui/refresh-button.js";
import { CodeEditor } from "../ui/code-editor.js";
import { useDataClient } from "./host.js";
import { dataPageOffset } from "./pagination.js";
import { DataSqlPanel, DataMigrationsPanel } from "./data-sql-panel.js";

import {
  DataErrorNotice,
  Field,
  type DataEnvironment,
} from "./data-ui.js";

const initialSchema = {
  tables: {
    contacts: {
      columns: {
        name: { type: "text" },
        email: { type: "text", unique: true },
        notes: { type: "text", nullable: true },
      },
    },
  },
};
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);

export function DataView({ projectId, enabled = true }: { projectId: string; enabled?: boolean }) {
  const client = useDataClient();
  const environment: DataEnvironment = "local";
  const admin = true;
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["data-resources", projectId, environment], enabled, retry: false, queryFn: client.list });
  const resources = query.data?.data ?? [];
  const selected = resources.find(resource => resource.id === selectedId) ?? resources[0];
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ["data-resources", projectId, environment] }); };
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="Databases" description="Structured data for your agents and applications." actions={
      <Button size="sm" disabled={!enabled || query.isError} onClick={() => setCreating(true)}><Plus size={13} />Create database</Button>
    } />
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="data-schema" className="text-[12px] font-medium text-muted-foreground">Schema</label>
      <SelectField id="data-schema" aria-label="Schema" className="w-48 max-w-64" value={selected?.id ?? null}
        disabled={!enabled || !resources.length} placeholder={query.isPending && enabled ? "Loading schemas…" : "No schemas"}
        options={resources.map(resource => ({ value: resource.id, label: resource.name }))} onChange={setSelectedId} />
      <div className="ml-auto"><RefreshButton disabled={!enabled} busy={query.isFetching} onClick={() => void refresh()} /></div>
    </div>
    {!enabled ? <EmptyState icon={<Database size={22} />} title="Databases are not enabled on this runtime">Ask its administrator to configure the Data backend.</EmptyState>
      : query.isPending ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading databases…</p>
      : query.isError ? <DataErrorNotice error={query.error} />
      : !resources.length ? <EmptyState icon={<Database size={22} />} title="Your first database">Create tables for your agents and applications.</EmptyState>
      : selected ? <ResourceView key={selected.id} {...{ projectId, environment, admin, refresh }} resource={selected} /> : null}
    {creating ? <SchemaDialog {...{ projectId, environment }} onClose={() => setCreating(false)} onSaved={async resource => { setSelectedId(resource.id); await refresh(); }} /> : null}
  </div>;
}

function ResourceView({
  projectId,
  environment,
  admin,
  resource,
  refresh,
}: {
  projectId: string;
  environment: DataEnvironment;
  admin: boolean;
  resource: DataResource;
  refresh(): Promise<void>;
}) {
  const client = useDataClient();
  const [tab, setTab] = useState<"records" | "query" | "migrations">(
    "records",
  );
  const tables = Object.keys(resource.schema.tables);
  const [selectedTable, setSelectedTable] = useState(tables[0] ?? "");
  const tableName = tables.includes(selectedTable) ? selectedTable : tables[0];
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(resource.name);
  const change = useMutation({
    mutationFn: async (kind: "rename" | "delete") => {
      if (kind === "delete") await client.remove(resource.id, resource.schemaVersion);
      else await client.rename(resource.id, { name, expectedVersion: resource.schemaVersion });
    },
    onSuccess: async () => {
      setDeleting(false);
      setRenaming(false);
      await refresh();
      toast.success("Database updated");
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-6 md:flex-row">
      <aside className="min-w-0 shrink-0 md:w-44">
        <Section title="Tables" count={tables.length}>
          <div className="hidden md:block">
            <SideTabs
              aria-label="Tables"
              tabs={tables.map((name) => ({
                id: name,
                label: (
                  <span className="flex items-center gap-2">
                    <Table size={14} className="shrink-0" />
                    <span className="truncate">{name}</span>
                  </span>
                ),
              }))}
              value={tableName ?? ""}
              onChange={(name) => {
                setSelectedTable(name);
                setTab("records");
              }}
            />
          </div>
          <div className="md:hidden">
            <TabBar
              aria-label="Tables"
              tabs={tables.map((name) => ({ id: name, label: name }))}
              value={tableName ?? ""}
              onChange={(name) => {
                setSelectedTable(name);
                setTab("records");
              }}
            />
          </div>
        </Section>
      </aside>
      <section className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <CopyId id={resource.id} label="database id" />
            <Chip>v{resource.schemaVersion}</Chip>
          </div>
          {admin ? (
            <TableRowActions label="Schema actions" busy={change.isPending}>
              <TableRowAction
                icon={<PencilSimple size={14} />}
                onSelect={() => setEditing(true)}
              >
                Edit schema
              </TableRowAction>
              <TableRowAction
                onSelect={() => {
                  change.reset();
                  setName(resource.name);
                  setRenaming(true);
                }}
              >
                Rename database
              </TableRowAction>
              <TableRowAction
                destructive
                icon={<Trash size={14} />}
                onSelect={() => {
                  change.reset();
                  setDeleting(true);
                }}
              >
                Delete database
              </TableRowAction>
            </TableRowActions>
          ) : null}
        </div>
        <TabBar
          aria-label="Database views"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "records", label: "Records" },
            { id: "query", label: "Query" },
            ...(admin
              ? [
                  { id: "migrations" as const, label: "Migrations" },
                ]
              : []),
          ]}
        />
        {tab === "records" ? (
          <RecordsView {...{ projectId, environment, resource, tableName }} />
        ) : tab === "query" ? (
          <DataSqlPanel {...{ projectId, environment, resource, tableName }} />
        ) : tab === "migrations" && admin ? (
          <DataMigrationsPanel
            {...{ projectId, environment, resource, refresh }}
          />
        ) : null}
        {editing ? (
          <SchemaDialog
            {...{ projectId, environment, resource }}
            onClose={() => setEditing(false)}
            onSaved={refresh}
          />
        ) : null}
        <Dialog
          open={deleting || renaming}
          onOpenChange={(open) => {
            if (!open && !change.isPending) {
              setDeleting(false);
              setRenaming(false);
            }
          }}
        >
          <DialogContent className="v2 sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {deleting ? `Delete ${resource.name}?` : "Rename database"}
              </DialogTitle>
              <DialogDescription>
                {deleting
                  ? "This permanently deletes every table and record in this database. This action cannot be undone."
                  : "The database ID and its grants remain the same."}
              </DialogDescription>
            </DialogHeader>
            {renaming ? (
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            ) : null}
            {change.isError ? <DataErrorNotice error={change.error} /> : null}
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                disabled={change.isPending}
                onClick={() => {
                  setDeleting(false);
                  setRenaming(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant={deleting ? "destructive" : "default"}
                disabled={change.isPending || (renaming && !name.trim())}
                onClick={() => change.mutate(deleting ? "delete" : "rename")}
              >
                {change.isPending
                  ? "Saving…"
                  : deleting
                    ? "Delete resource"
                    : "Save name"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}

function SchemaDialog({
  projectId,
  environment,
  resource,
  onClose,
  onSaved,
}: {
  projectId: string;
  environment: DataEnvironment;
  resource?: DataResource;
  onClose(): void;
  onSaved(resource: DataResource): Promise<void>;
}) {
  const client = useDataClient();
  const [name, setName] = useState("");
  const [schema, setSchema] = useState(
    jsonText(resource?.schema ?? initialSchema),
  );
  const save = useMutation({
    mutationFn: () =>
      resource
        ? client.migrate(resource.id, { expectedVersion: resource.schemaVersion, schema: JSON.parse(schema) })
        : client.create({ name, schema: JSON.parse(schema) }),
    onSuccess: async (response) => {
      await onSaved(response.data);
      toast.success(resource ? "Schema saved" : "Database created");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent className="v2 max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {resource ? "Edit schema" : "Create database"}
          </DialogTitle>
          <DialogDescription>
            {resource
              ? "Add tables or nullable columns. Existing columns and tables are preserved. A stale schema version is rejected."
              : "Name a database and define its tables. The example below is ready to use."}
          </DialogDescription>
        </DialogHeader>
        {!resource ? (
          <Field label="Database name">
            <Input
              placeholder="crm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z][a-z0-9_-]*"
            />
          </Field>
        ) : null}
        <Field label="Table schema (JSON)">
          <CodeEditor
            ariaLabel="Table schema (JSON)"
            language="json"
            height={320}
            value={schema}
            readOnly={save.isPending}
            onChange={setSchema}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Column types: text, integer, number, boolean, timestamp, uuid, json.
          Use nullable, unique, references and indexes to define your model.
        </p>
        {save.isError ? <DataErrorNotice error={save.error} /> : null}
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || (!resource && !name.trim())}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Saving…"
              : resource
                ? "Save schema"
                : "Create database"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordsView({
  projectId,
  environment,
  resource,
  tableName,
}: {
  projectId: string;
  environment: DataEnvironment;
  resource: DataResource;
  tableName?: string;
}) {
  return tableName ? (
    <TableRecords
      key={`${tableName}:${resource.schemaVersion}`}
      {...{ projectId, environment, resource, tableName }}
      table={resource.schema.tables[tableName]}
    />
  ) : (
    <p className="text-sm text-muted-foreground">
      This database has no tables. Add one using Edit schema or Migrations.
    </p>
  );
}

function TableRecords({
  projectId,
  environment,
  resource,
  tableName,
  table,
}: {
  projectId: string;
  environment: DataEnvironment;
  resource: DataResource;
  tableName: string;
  table: DataTableSchema;
}) {
  const client = useDataClient();
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<DataRow | "new" | null>(null);
  const [removing, setRemoving] = useState<DataRow | null>(null);
  const queryClient = useQueryClient();
  const queryKey = [
    "data-records",
    projectId,
    environment,
    resource.id,
    tableName,
    offset,
  ];
  const request = (operations: unknown[], idempotencyKey?: string) =>
    client.transaction(resource.id, { operations, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const query = useQuery({
    queryKey,
    queryFn: () =>
      request([{ op: "list", table: tableName, limit: 25, offset }]),
    retry: false,
  });
  const result = query.data?.data[0];
  // A refetch may shrink the table, including deletion by another client.
  // Change the query offset before rendering an empty, out-of-range page.
  if (result?.total !== undefined) {
    const nextOffset = dataPageOffset(offset, result.total);
    if (nextOffset !== offset) setOffset(nextOffset);
  }
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKey.slice(0, 5) });
  const remove = useMutation({
    mutationFn: (row: DataRow) =>
      request([
        {
          op: "delete",
          table: tableName,
          id: row._id,
          expectedVersion: row._version,
        },
      ]),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
      toast.success("Record deleted");
    },
  });
  const columns: ColumnDef<DataRow, unknown>[] = [
    {
      id: "_id",
      header: "Record ID",
      enableSorting: false,
      cell: ({ row }) => (
        <CopyId id={row.original._id} label="id" className="max-w-48" />
      ),
    },
    ...Object.keys(table.columns).map<ColumnDef<DataRow, unknown>>((name) => ({
      id: name,
      header: name,
      accessorFn: (row) => row[name],
      enableSorting: false,
      cell: ({ row }) => {
        const value = row.original[name];
        const text =
          value === null
            ? "null"
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
        return (
          <span
            className={`block max-w-64 truncate text-[13px] ${value === null ? "text-muted-foreground" : ""}`}
            title={text}
          >
            {text}
          </span>
        );
      },
    })),
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { align: "right", width: 48 },
      cell: ({ row }) => (
        <div className="flex justify-end">
          <TableRowActions label={`Actions for record ${row.original._id}`}>
            <TableRowAction
              icon={<PencilSimple size={14} />}
              onSelect={() => setEditor(row.original)}
            >
              Edit record
            </TableRowAction>
            <TableRowAction
              destructive
              icon={<Trash size={14} />}
              onSelect={() => {
                remove.reset();
                setRemoving(row.original);
              }}
            >
              Delete record
            </TableRowAction>
          </TableRowActions>
        </div>
      ),
    },
  ];
  return (
    <Section
      title={tableName}
      count={result?.total}
      action={
        <div className="flex items-center gap-3">
          <RefreshButton busy={query.isFetching} onClick={() => void refresh()} />
          <Button size="sm" className="gap-1.5" onClick={() => setEditor("new")}>
            <Plus size={13} />Add record
          </Button>
        </div>
      }
    >
      {query.isPending ? (
        <p
          role="status"
          className="py-12 text-center text-[13px] text-muted-foreground"
        >
          Loading records…
        </p>
      ) : query.isError ? (
        <DataErrorNotice error={query.error} />
      ) : (
        <DataTable
          columns={columns}
          data={result?.rows ?? []}
          getRowId={(row) => row._id}
          pagination={{
            pageIndex: offset / 25,
            pageSize: 25,
            rowCount: result?.total ?? 0,
            hasNextPage:
              result?.nextOffset != null && result.nextOffset <= 10000,
            disabled: query.isFetching,
            onPageChange: (page) => setOffset(page * 25),
          }}
          empty={
            <span className="text-[13px] text-muted-foreground">
              No records yet. Add your first record.
            </span>
          }
        />
      )}
      {editor ? (
        <RecordDialog
          table={table}
          row={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          save={async (values, idempotencyKey) => {
            await request(
              [
                {
                  op: editor === "new" ? "insert" : "update",
                  table: tableName,
                  values,
                  ...(editor === "new"
                    ? {}
                    : { id: editor._id, expectedVersion: editor._version }),
                },
              ],
              idempotencyKey,
            );
            await refresh();
          }}
        />
      ) : null}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent className="v2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete record?</DialogTitle>
            <DialogDescription>
              This permanently removes this record. Related records may prevent
              deletion.
            </DialogDescription>
          </DialogHeader>
          {remove.isError ? <DataErrorNotice error={remove.error} /> : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? "Deleting…" : "Delete record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function RecordDialog({
  table,
  row,
  onClose,
  save,
}: {
  table: DataTableSchema;
  row?: DataRow;
  onClose(): void;
  save(
    values: Record<string, DataValue>,
    idempotencyKey: string,
  ): Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(table.columns).map(([name, column]) => [
        name,
        row?.[name] == null
          ? ""
          : column.type === "json"
            ? jsonText(row[name])
            : String(row[name]),
      ]),
    ),
  );
  // Keep the key stable for retrying an unchanged form after an ambiguous response.
  const [attempt, setAttempt] = useState({ body: "", key: "" });
  const mutation = useMutation({
    mutationFn: async () => {
      const parsed: Record<string, DataValue> = {};
      for (const [name, column] of Object.entries(table.columns)) {
        const value = values[name] ?? "";
        parsed[name] =
          value === "" && column.nullable
            ? null
            : column.type === "json"
              ? JSON.parse(value)
              : ["integer", "number"].includes(column.type)
                ? value.trim() === ""
                  ? (() => {
                      throw new Error(`${name} requires a number`);
                    })()
                  : Number(value)
                : column.type === "boolean"
                  ? value === "true"
                    ? true
                    : value === "false"
                      ? false
                      : (() => {
                          throw new Error(`${name} requires true or false`);
                        })()
                  : value;
      }
      const body = JSON.stringify(parsed);
      const key = body === attempt.body ? attempt.key : crypto.randomUUID();
      setAttempt({ body, key });
      await save(parsed, key);
    },
    onSuccess: () => {
      toast.success("Record saved");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent className="v2 max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? "Edit record" : "Add record"}</DialogTitle>
          <DialogDescription>
            {row
              ? `Revision ${row._version}. Concurrent changes are protected.`
              : "Fill in the table fields. Leave optional fields empty for null."}
          </DialogDescription>
        </DialogHeader>
        {Object.entries(table.columns).map(([name, column]) => (
          <Field
            key={name}
            label={`${name} · ${column.type}${column.nullable ? " (optional)" : ""}`}
          >
            {column.type === "json" ? (
              <CodeEditor
                ariaLabel={name}
                language="json"
                height={160}
                value={values[name]}
                readOnly={mutation.isPending}
                onChange={(value) =>
                  setValues((previous) => ({
                    ...previous,
                    [name]: value,
                  }))
                }
              />
            ) : column.type === "boolean" ? (
              <SelectField
                aria-label={name}
                size="default"
                className="w-full"
                placeholder="Choose…"
                value={values[name] || (column.nullable ? "null" : null)}
                onChange={(value) =>
                  setValues((previous) => ({
                    ...previous,
                    [name]: value === "null" ? "" : value,
                  }))
                }
                options={[
                  ...(column.nullable
                    ? [{ value: "null", label: "null" }]
                    : []),
                  { value: "true", label: "true" },
                  { value: "false", label: "false" },
                ]}
              />
            ) : (
              <Input
                value={values[name]}
                placeholder={
                  column.type === "timestamp"
                    ? "2026-10-09T12:00:00Z"
                    : undefined
                }
                onChange={(e) =>
                  setValues((previous) => ({
                    ...previous,
                    [name]: e.target.value,
                  }))
                }
              />
            )}
          </Field>
        ))}
        {mutation.isError ? <DataErrorNotice error={mutation.error} /> : null}
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Saving…" : "Save record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
