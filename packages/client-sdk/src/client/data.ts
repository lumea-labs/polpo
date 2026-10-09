import type {
  DataBatch,
  DataListQuery,
  DataMigration,
  DataRename,
  DataResource,
  DataResult,
  DataRow,
  DataValue,
} from "@polpo-ai/core/data";

export type DataRequest = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;
export type DataWriteOptions = { idempotencyKey?: string };
export class DataResourceClient {
  constructor(
    private readonly request: DataRequest,
    private readonly reference: string,
  ) {}
  private get path(): string {
    return `/data/${encodeURIComponent(this.reference)}`;
  }
  describe(): Promise<DataResource> {
    return this.request("GET", this.path);
  }
  migrate(input: DataMigration): Promise<DataResource> {
    return this.request("PUT", `${this.path}/schema`, input);
  }
  rename(input: DataRename): Promise<DataResource> {
    return this.request("PATCH", this.path, input);
  }
  remove(expectedVersion: number): Promise<{ deleted: boolean }> {
    return this.request(
      "DELETE",
      `${this.path}?expectedVersion=${encodeURIComponent(expectedVersion)}`,
    );
  }
  transaction(
    operations: DataBatch["operations"],
    options?: DataWriteOptions,
  ): Promise<DataResult[]> {
    return this.request("POST", `${this.path}/transactions`, {
      operations,
      ...options,
    });
  }
  table(name: string) {
    const one = async (
      operation: DataBatch["operations"][number],
      options?: DataWriteOptions,
    ): Promise<DataRow> => {
      const [result] = await this.transaction([operation], options);
      return result.rows[0];
    };
    return {
      list: async (query: DataListQuery = {}): Promise<DataResult> =>
        (await this.transaction([{ ...query, op: "list", table: name }]))[0],
      insert: (values: Record<string, DataValue>, options?: DataWriteOptions) =>
        one({ op: "insert", table: name, values }, options),
      upsert: (
        values: Record<string, DataValue>,
        onConflict: string[],
        options?: DataWriteOptions,
      ) => one({ op: "upsert", table: name, values, onConflict }, options),
      update: (
        id: string,
        values: Record<string, DataValue>,
        expectedVersion: number,
        options?: DataWriteOptions,
      ) =>
        one(
          { op: "update", table: name, id, values, expectedVersion },
          options,
        ),
      delete: (
        id: string,
        expectedVersion: number,
        options?: DataWriteOptions,
      ) => one({ op: "delete", table: name, id, expectedVersion }, options),
    };
  }
}
