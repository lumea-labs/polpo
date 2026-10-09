"use client";

import { useMemo } from "react";
import { usePolpo } from "@polpo-ai/react";
import {
  CreateDataSchema, DataBatchSchema, DataQuerySchema, DataSqlMigrationSchema,
  MigrateDataSchema, RenameDataSchema,
} from "@polpo-ai/core/data";
import type { PolpoClient } from "@polpo-ai/sdk";

const response = async <T,>(result: Promise<T>) => ({ ok: true as const, data: await result });

/** The host's SDK owns URL, authentication and transport; no managed-only endpoints. */
export function createDataClient(client: PolpoClient) {
  return {
    list: async () => {
      try {
        return await response(client.listData());
      } catch (error) {
        // A missing collection route means this host has not enabled Data.
        // Resource-specific 404s must keep their normal not-found meaning.
        if (error && typeof error === "object" && "status" in error && error.status === 404) {
          throw new Error("Databases are not configured on this runtime. Ask its administrator to enable the Data backend.");
        }
        throw error;
      }
    },
    create: (input: unknown) => response(client.createData(CreateDataSchema.parse(input))),
    rename: (id: string, input: unknown) => response(client.data(id).rename(RenameDataSchema.parse(input))),
    remove: (id: string, expectedVersion: number) => response(client.data(id).remove(expectedVersion)),
    migrate: (id: string, input: unknown) => response(client.data(id).migrate(MigrateDataSchema.parse(input))),
    transaction: (id: string, input: unknown) => {
      const { operations, idempotencyKey } = DataBatchSchema.parse(input);
      return response(client.data(id).transaction(operations, { idempotencyKey }));
    },
    query: (id: string, input: unknown) => response(client.data(id).query(DataQuerySchema.parse(input))),
    migrateSql: (id: string, input: unknown) => response(client.data(id).migrateSql(DataSqlMigrationSchema.parse(input))),
    migrations: (id: string) => response(client.data(id).migrations()),
  };
}

export function useDataClient() {
  const { client } = usePolpo();
  return useMemo(() => createDataClient(client), [client]);
}
