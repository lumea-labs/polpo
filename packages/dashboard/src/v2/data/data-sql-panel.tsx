"use client";

import { useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DataMigrationRecord,
  DataQueryResult,
  DataResource,
} from "@polpo-ai/core/data";
import { Button } from "../ui/button.js";
import { SelectField } from "../ui/select-field.js";
import { CodeEditor } from "../ui/code-editor.js";
import { DataTable } from "../ui/data-table.js";
import { Section } from "../ui/bits.js";
import { useDataClient } from "./host.js";
import {
  DataErrorNotice,
  Field,
  type DataEnvironment,
} from "./data-ui.js";

type DatabaseProps = {
  projectId: string;
  environment: DataEnvironment;
  resource: DataResource;
};

export function DataSqlPanel({
  projectId,
  environment,
  resource,
  tableName,
}: DatabaseProps & { tableName?: string }) {
  const data = useDataClient();
  const [sql, setSql] = useState(
    tableName ? `SELECT * FROM "${tableName}" LIMIT 20` : "SELECT 1 AS value",
  );
  const [params, setParams] = useState("[]");
  const [mode, setMode] = useState<"read" | "write">("read");
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const client = useQueryClient();
  const run = useMutation({
    mutationFn: async () => {
      const input = { sql, params: JSON.parse(params), mode, maxRows: 50 };
      const signature = JSON.stringify(input);
      if (!retry.current || retry.current.signature !== signature)
        retry.current = { signature, key: crypto.randomUUID() };
      const response = await data.query(resource.id, {
        ...input, ...(mode === "write" ? { idempotencyKey: retry.current.key } : {}),
      });
      return { ...response, mode };
    },
    onSuccess: async () => {
      retry.current = null;
      await client.invalidateQueries({
        queryKey: ["data-records", projectId, environment, resource.id],
      });
    },
  });
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Query tables in this database using PostgreSQL syntax. Use $1, $2 and
        the parameters below for values. Schema changes belong in Migrations.
      </p>
      <Field label="SQL">
        <CodeEditor
          ariaLabel="SQL"
          language="sql"
          height={240}
          value={sql}
          readOnly={run.isPending}
          onChange={setSql}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <Field label="Parameters (JSON array)">
          <CodeEditor
            ariaLabel="Parameters (JSON array)"
            language="json"
            height={80}
            value={params}
            readOnly={run.isPending}
            onChange={setParams}
          />
        </Field>
        <Field label="Query mode">
          <SelectField<"read" | "write">
            aria-label="Query mode"
            className="w-full"
            value={mode}
            disabled={run.isPending}
            options={[
              { value: "read", label: "Read" },
              { value: "write", label: "Write" },
            ]}
            onChange={setMode}
          />
        </Field>
      </div>
      {mode === "write" ? (
        <p className="text-xs text-muted-foreground">
          INSERT, UPDATE and DELETE change records in this database. Use WHERE _version = …
          when an update depends on a previously read record.
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={run.isPending || !sql.trim()}
        onClick={() => run.mutate()}
      >
        {run.isPending
          ? "Running…"
          : mode === "write"
            ? "Run mutation"
            : "Run query"}
      </Button>
      {run.isError ? <DataErrorNotice error={run.error} /> : null}
      {run.data ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            {run.data.data.rows.length} rows shown
            {run.data.data.truncated ? " · result truncated" : ""} ·{" "}
            {run.data.data.rowCount} rows{" "}
            {run.data.mode === "write" ? "affected" : "fetched"}
          </p>
          <DataTable
            data={run.data.data.rows}
            columns={[
              ...new Set(run.data.data.rows.flatMap((row) => Object.keys(row))),
            ].map<ColumnDef<DataQueryResult["rows"][number], unknown>>((name) => ({
              id: name,
              header: name,
              accessorFn: (row) => row[name],
              cell: ({ getValue }) => {
                const value = getValue();
                const text =
                  value === null
                    ? "null"
                    : typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value);
                return (
                  <span
                    className="block max-w-64 truncate text-[13px]"
                    title={text}
                  >
                    {text}
                  </span>
                );
              },
            }))}
            pageSize={25}
            empty={
              <span className="text-[13px] text-muted-foreground">
                The query returned no rows.
              </span>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export function DataMigrationsPanel({
  projectId,
  environment,
  resource,
  refresh,
}: DatabaseProps & { refresh(): Promise<void> }) {
  const data = useDataClient();
  const [input, setInput] = useState(() =>
    JSON.stringify(
      {
        id: "add_notes",
        expectedVersion: resource.schemaVersion,
        statements: [{ sql: "CREATE TABLE notes (body text NOT NULL)" }],
      },
      null,
      2,
    ),
  );
  const client = useQueryClient();
  const key = ["data-migrations", projectId, environment, resource.id];
  const history = useQuery({
    queryKey: key,
    retry: false,
    queryFn: () =>
      data.migrations(resource.id),
  });
  const apply = useMutation({
    mutationFn: () =>
      data.migrateSql(resource.id, JSON.parse(input)),
    onSuccess: async () => {
      await Promise.all([
        refresh(),
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: ["data-records", projectId, environment, resource.id],
        }),
      ]);
    },
  });
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Apply supported table and index changes with data backfills in one
        transaction. Each statement has a SQL string and optional parameters.
        Current schema: v{resource.schemaVersion}.
      </p>
      <Field label="SQL migration (JSON)">
        <CodeEditor
          ariaLabel="SQL migration (JSON)"
          language="json"
          height={300}
          value={input}
          readOnly={apply.isPending}
          onChange={(value) => {
            setInput(value);
            apply.reset();
          }}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Use a unique migration ID and the current expectedVersion. Repeating the
        same migration is safe. Drops and type changes require allowDestructive:
        true.
      </p>
      <Button
        size="sm"
        disabled={apply.isPending || !input.trim()}
        onClick={() => apply.mutate()}
      >
        {apply.isPending
          ? "Applying…"
          : "Apply migration"}
      </Button>
      {apply.isError ? <DataErrorNotice error={apply.error} /> : null}
      {apply.data ? (
        <p role="status" className="text-sm">
          Migration applied · schema v{apply.data.data.schemaVersion}
        </p>
      ) : null}
      <Section title="Migration history" count={history.data?.data.length}>
        {history.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading migrations…
          </p>
        ) : history.isError ? (
          <DataErrorNotice error={history.error} />
        ) : (
          <DataTable
            columns={migrationColumns}
            data={history.data.data}
            getRowId={(entry) => entry.id}
            empty={
              <span className="text-[13px] text-muted-foreground">
                No SQL migrations yet.
              </span>
            }
          />
        )}
      </Section>
    </div>
  );
}

const migrationColumns: ColumnDef<DataMigrationRecord, unknown>[] = [
  {
    accessorKey: "id",
    header: "Migration",
    cell: ({ row }) => (
      <span className="font-mono text-[12px]">{row.original.id}</span>
    ),
  },
  {
    accessorKey: "schemaVersion",
    header: "Version",
    cell: ({ row }) => (
      <span className="text-[13px]">v{row.original.schemaVersion}</span>
    ),
  },
  {
    accessorKey: "appliedAt",
    header: "Applied",
    cell: ({ row }) => (
      <span className="text-[12px] text-muted-foreground">
        {new Date(row.original.appliedAt).toLocaleString()}
      </span>
    ),
  },
];
