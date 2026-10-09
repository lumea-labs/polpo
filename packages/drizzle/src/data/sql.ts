import { parse, toSql } from "pgsql-ast-parser";
import { dataValueConstraint, dataValueConstraintName } from "./constraints.js";
import {
  DataError,
  DataIdentifier,
  DataIndexName,
  DataSchema,
  parseData,
  type DataColumn,
  type DataQueryAccess,
  type DataSchemaDefinition,
} from "@polpo-ai/core/data";

const fail = (message: string): never => {
  throw new DataError("data_invalid", message);
};
const denied = (): never => {
  throw new DataError("data_forbidden", "SQL table access is not granted");
};
export const quote = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    return fail("Invalid SQL identifier");
  return `"${name}"`;
};
const userName = (name: string): string => parseData(DataIdentifier, name);
const types: Record<string, DataColumn["type"]> = {
  text: "text",
  varchar: "text",
  integer: "integer",
  int: "integer",
  int4: "integer",
  "double precision": "number",
  float8: "number",
  boolean: "boolean",
  bool: "boolean",
  timestamptz: "timestamp",
  "timestamp with time zone": "timestamp",
  uuid: "uuid",
  json: "json",
  jsonb: "json",
};
export const sqlTypes = {
  text: "text",
  integer: "integer",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
  uuid: "uuid",
  json: "jsonb",
};
const safeFunctions = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "lower",
  "upper",
  "length",
  "char_length",
  "btrim",
  "ltrim",
  "rtrim",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "abs",
  "round",
  "floor",
  "ceil",
  "ceiling",
  "date_trunc",
  "now",
  "jsonb_build_object",
  "jsonb_build_array",
  "jsonb_agg",
  "json_agg",
  "array_agg",
  "string_agg",
  "gen_random_uuid",
]);
const safeExpressions = new Set([
  "ref",
  "parameter",
  "list",
  "array",
  "null",
  "integer",
  "numeric",
  "string",
  "boolean",
  "case",
  "binary",
  "unary",
  "cast",
  "call",
  "select",
  "union",
  "union all",
  "values",
  "ternary",
  "member",
  "keyword",
]);
export function parseSql(sql: string): any[] {
  try {
    const parsed = parse(sql, { locationTracking: true });
    boundedTree(parsed);
    const stripLocations = (value: any): any => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(stripLocations);
      // This parser reads `SELECT 1e3` as `SELECT 1 AS e3`. Refuse
      // scientific literals rather than silently changing their value;
      // parameter binding supports finite JavaScript numbers directly.
      if (
        ["integer", "numeric"].includes(value.type) &&
        value._location &&
        /^[eE][+-]?[0-9]/.test(sql.slice(value._location.end))
      )
        fail(
          "Scientific SQL literals are not supported; bind a numeric parameter",
        );
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "_location")
          .map(([key, child]) => [key, stripLocations(child)]),
      );
    };
    return stripLocations(parsed);
  } catch (error) {
    if (error instanceof DataError) throw error;
    return fail("SQL syntax is invalid or unsupported");
  }
}
function plainName(value: any): string {
  if (!value || value.schema || value.database)
    return fail("Use unqualified logical table names");
  return userName(value.name);
}
function sqlType(value: any): DataColumn["type"] {
  if (
    !value ||
    value.schema ||
    value.kind === "array" ||
    value.config?.length ||
    !Object.hasOwn(types, value.name)
  )
    return fail("Unsupported database column or cast type");
  return types[value.name];
}
function boundedTree(value: any, depth = 0, count = { n: 0 }): void {
  if (++count.n > 5000 || depth > 64) fail("SQL expression is too complex");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "opSchema" && child)
      fail("Custom SQL operators are not supported");
    boundedTree(child, depth + 1, count);
  }
}
/** Parse, authorize and regenerate SQL. Never execute the caller's raw string. */
export function compileQuery(
  sql: string,
  namespace: string,
  schema: DataSchemaDefinition,
  access: DataQueryAccess,
  mode: "read" | "write",
  parameterCount: number,
): { sql: string; write: boolean } {
  const parsed = parseSql(sql);
  if (parsed.length !== 1)
    return fail("A query must contain exactly one statement");
  const root = parsed[0];
  boundedTree(root);
  const write = ["insert", "update", "delete"].includes(root.type);
  if (
    mode === "read"
      ? !["select", "union", "union all", "values"].includes(root.type)
      : !write
  )
    return fail(
      "Use read mode for SELECT and write mode for INSERT, UPDATE or DELETE",
    );
  const table = (name: any, action: "read" | "write") => {
    const logical = plainName(name);
    if (
      !(action === "read" ? access.readTables : access.writeTables).includes(
        logical,
      )
    )
      denied();
    if (!Object.hasOwn(schema.tables, logical)) fail("Unknown SQL table");
    return { ...name, schema: namespace };
  };
  let target: string | undefined;
  if (write) {
    target = plainName(
      root.type === "insert"
        ? root.into
        : root.type === "update"
          ? root.table
          : root.from,
    );
    if (!access.writeTables.includes(target)) denied();
    const definition = schema.tables[target];
    if (!definition) fail("Unknown SQL table");
    const validateColumn = (name: string) => {
      if (!Object.hasOwn(definition.columns, name))
        fail("SQL writes cannot change system columns or unknown columns");
    };
    if (root.type === "insert") {
      if (!root.columns?.length || root.overriding)
        fail("INSERT requires explicit user columns");
      root.columns.forEach((c: any) => validateColumn(c.name));
      if (
        new Set(root.columns.map((c: any) => c.name)).size !==
        root.columns.length
      )
        fail("Duplicate INSERT column");
      if (root.onConflict?.do && root.onConflict.do !== "do nothing")
        root.onConflict.do.sets.forEach((s: any) =>
          validateColumn(s.column.name),
        );
    } else if (root.type === "update")
      root.sets.forEach((s: any) => validateColumn(s.column.name));
  }
  const parameters = new Set<number>();
  // This is deliberately independent of the parser's convenience AST mapper:
  // that mapper skips expressions in DISTINCT ON, OVER, ON CONFLICT WHERE and
  // cast target types. Every accepted field is checked and rebuilt here; a new
  // parser field fails closed until its meaning has been reviewed.
  const shape = (node: any, keys: string[]): void => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      Object.keys(node).some((key) => !keys.includes(key))
    )
      fail("SQL construct is not supported");
  };
  const identifierName = (name: any): string => {
    if (typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(name))
      fail("Invalid SQL identifier");
    return name;
  };
  const simpleName = (node: any): any => {
    shape(node, ["name"]);
    return { name: identifierName(node.name) };
  };
  const optional = (node: any, visit: (node: any) => any): any =>
    node == null ? node : visit(node);
  const array = (nodes: any, visit: (node: any) => any): any[] => {
    if (!Array.isArray(nodes)) return fail("SQL construct is not supported");
    return nodes.map(visit);
  };
  const enumValue = (value: any, allowed: string[]): any => {
    if (!allowed.includes(value)) fail("SQL construct is not supported");
    return value;
  };
  const tableName = (node: any, action: "read" | "write"): any => {
    shape(node, ["name", "schema", "alias"]);
    return table(
      {
        name: node.name,
        ...(node.schema ? { schema: node.schema } : {}),
        ...(node.alias ? { alias: identifierName(node.alias) } : {}),
      },
      action,
    );
  };
  const order = (node: any): any => {
    shape(node, ["by", "order", "nulls"]);
    return {
      by: expr(node.by),
      order: optional(node.order, (v) => enumValue(v, ["ASC", "DESC"])),
      nulls: optional(node.nulls, (v) => enumValue(v, ["FIRST", "LAST"])),
    };
  };
  const selected = (node: any): any => {
    shape(node, ["expr", "alias"]);
    return { expr: expr(node.expr), alias: optional(node.alias, simpleName) };
  };
  const join = (node: any): any => {
    shape(node, ["type", "on", "using"]);
    return {
      type: enumValue(node.type, [
        "INNER JOIN",
        "LEFT JOIN",
        "RIGHT JOIN",
        "FULL JOIN",
        "CROSS JOIN",
      ]),
      on: optional(node.on, expr),
      using: optional(node.using, (v) => array(v, simpleName)),
    };
  };
  const from = (node: any): any => {
    if (node?.type === "table") {
      shape(node, ["type", "name", "join"]);
      return {
        type: "table",
        name: tableName(node.name, "read"),
        join: optional(node.join, join),
      };
    }
    if (node?.type === "statement") {
      shape(node, ["type", "statement", "alias", "join"]);
      return {
        type: "statement",
        statement: statement(node.statement),
        alias: identifierName(node.alias),
        join: optional(node.join, join),
      };
    }
    return fail(
      "Table functions and unsupported FROM constructs are not supported",
    );
  };
  const assignment = (node: any): any => {
    shape(node, ["column", "value"]);
    return { column: simpleName(node.column), value: expr(node.value) };
  };
  const conflict = (node: any): any => {
    shape(node, ["on", "do", "where"]);
    let on: any;
    if (node.on) {
      if (node.on.type !== "on expr")
        fail(
          "Use explicit conflict columns instead of physical constraint names",
        );
      shape(node.on, ["type", "exprs"]);
      on = { type: "on expr", exprs: array(node.on.exprs, expr) };
    }
    let action: any = node.do;
    if (action !== "do nothing") {
      shape(action, ["sets"]);
      action = { sets: array(action.sets, assignment) };
    }
    return { on, do: action, where: optional(node.where, expr) };
  };
  const statement = (node: any, isRoot = false): any => {
    if (
      !node ||
      ![
        "select",
        "union",
        "union all",
        "values",
        "insert",
        "update",
        "delete",
      ].includes(node.type)
    )
      return fail("SQL statement is not supported");
    if (["insert", "update", "delete"].includes(node.type) && !isRoot)
      fail("Nested SQL mutations are not supported");
    if (node.type === "select") {
      shape(node, [
        "type",
        "columns",
        "from",
        "where",
        "groupBy",
        "having",
        "orderBy",
        "limit",
        "distinct",
      ]);
      if (node.limit) shape(node.limit, ["limit", "offset"]);
      return {
        type: node.type,
        columns: optional(node.columns, (v) => array(v, selected)),
        from: optional(node.from, (v) => array(v, from)),
        where: optional(node.where, expr),
        groupBy: optional(node.groupBy, (v) => array(v, expr)),
        having: optional(node.having, expr),
        orderBy: optional(node.orderBy, (v) => array(v, order)),
        limit: node.limit && {
          limit: optional(node.limit.limit, expr),
          offset: optional(node.limit.offset, expr),
        },
        distinct: optional(node.distinct, (v) =>
          Array.isArray(v) ? array(v, expr) : enumValue(v, ["all", "distinct"]),
        ),
      };
    }
    if (node.type === "union" || node.type === "union all") {
      shape(node, ["type", "left", "right"]);
      return {
        type: node.type,
        left: statement(node.left),
        right: statement(node.right),
      };
    }
    if (node.type === "values") {
      shape(node, ["type", "values"]);
      return {
        type: node.type,
        values: array(node.values, (v) => array(v, expr)),
      };
    }
    if (node.type === "insert") {
      shape(node, [
        "type",
        "into",
        "insert",
        "columns",
        "returning",
        "onConflict",
      ]);
      return {
        type: node.type,
        into: tableName(node.into, "write"),
        insert: statement(node.insert),
        columns: array(node.columns, simpleName),
        returning: optional(node.returning, (v) => array(v, selected)),
        onConflict: optional(node.onConflict, conflict),
      };
    }
    if (node.type === "update") {
      shape(node, ["type", "table", "sets", "where", "from", "returning"]);
      return {
        type: node.type,
        table: tableName(node.table, "write"),
        sets: array(node.sets, assignment),
        where: optional(node.where, expr),
        from: optional(node.from, from),
        returning: optional(node.returning, (v) => array(v, selected)),
      };
    }
    shape(node, ["type", "from", "where", "returning"]);
    return {
      type: node.type,
      from: tableName(node.from, "write"),
      where: optional(node.where, expr),
      returning: optional(node.returning, (v) => array(v, selected)),
    };
  };
  const expr = (node: any): any => {
    if (!node || !safeExpressions.has(node.type))
      return fail("SQL expression is not supported");
    switch (node.type) {
      case "select":
      case "union":
      case "union all":
      case "values":
        return statement(node);
      case "ref": {
        shape(node, ["type", "table", "name"]);
        if (node.name !== "*") identifierName(node.name);
        if (
          ["tableoid", "xmin", "xmax", "cmin", "cmax", "ctid"].includes(
            node.name,
          )
        )
          fail("Physical system columns are not exposed");
        return {
          type: node.type,
          name: node.name,
          table: optional(node.table, simpleName),
        };
      }
      case "parameter": {
        shape(node, ["type", "name"]);
        const number = /^\$[1-9][0-9]*$/.test(node.name)
          ? Number(node.name.slice(1))
          : 0;
        if (!number || number > parameterCount)
          fail("SQL parameter is missing");
        parameters.add(number);
        return { type: node.type, name: node.name };
      }
      case "null":
        shape(node, ["type"]);
        return { type: node.type };
      case "string":
      case "boolean":
      case "numeric":
      case "integer":
        shape(node, ["type", "value"]);
        if (
          ["numeric", "integer"].includes(node.type) &&
          !Number.isFinite(node.value)
        )
          fail("SQL numeric literal must be finite");
        return { type: node.type, value: node.value };
      case "list":
      case "array":
        shape(node, ["type", "expressions"]);
        return { type: node.type, expressions: array(node.expressions, expr) };
      case "keyword":
        shape(node, ["type", "keyword"]);
        return {
          type: node.type,
          keyword: enumValue(node.keyword, [
            "current_date",
            "current_timestamp",
            "current_time",
            "localtimestamp",
            "localtime",
          ]),
        };
      case "cast":
        shape(node, ["type", "operand", "to"]);
        shape(node.to, ["name", "doubleQuoted"]);
        sqlType(node.to);
        return {
          type: node.type,
          operand: expr(node.operand),
          to: { name: node.to.name },
        };
      case "unary":
        shape(node, ["type", "op", "operand"]);
        return {
          type: node.type,
          op: enumValue(node.op, [
            "+",
            "-",
            "NOT",
            "IS NULL",
            "IS NOT NULL",
            "IS TRUE",
            "IS FALSE",
            "IS NOT TRUE",
            "IS NOT FALSE",
          ]),
          operand: expr(node.operand),
        };
      case "binary":
        shape(node, ["type", "op", "left", "right"]);
        return {
          type: node.type,
          op: enumValue(node.op, [
            "OR",
            "AND",
            "IN",
            "NOT IN",
            "LIKE",
            "NOT LIKE",
            "ILIKE",
            "NOT ILIKE",
            "=",
            "!=",
            ">",
            ">=",
            "<",
            "<=",
            "@>",
            "<@",
            "?",
            "?|",
            "?&",
            "#>>",
            "~",
            "~*",
            "!~",
            "!~*",
            "@@",
            "||",
            "-",
            "#-",
            "&&",
            "+",
            "*",
            "%",
            "/",
            "|",
            "&",
            ">>",
            "^",
            "#",
            "<<",
            "AT TIME ZONE",
          ]),
          left: expr(node.left),
          right: expr(node.right),
        };
      case "member":
        shape(node, ["type", "operand", "op", "member"]);
        if (
          typeof node.member !== "string" &&
          !Number.isSafeInteger(node.member)
        )
          fail("Invalid JSON member");
        return {
          type: node.type,
          operand: expr(node.operand),
          op: enumValue(node.op, ["->", "->>"]),
          member: node.member,
        };
      case "ternary":
        shape(node, ["type", "op", "value", "lo", "hi"]);
        return {
          type: node.type,
          op: enumValue(node.op, ["BETWEEN", "NOT BETWEEN"]),
          value: expr(node.value),
          lo: expr(node.lo),
          hi: expr(node.hi),
        };
      case "case":
        shape(node, ["type", "value", "whens", "else"]);
        return {
          type: node.type,
          value: optional(node.value, expr),
          else: optional(node.else, expr),
          whens: array(node.whens, (w) => {
            shape(w, ["when", "value"]);
            return { when: expr(w.when), value: expr(w.value) };
          }),
        };
      case "call": {
        shape(node, [
          "type",
          "function",
          "args",
          "distinct",
          "orderBy",
          "filter",
          "withinGroup",
          "over",
        ]);
        shape(node.function, ["name", "schema"]);
        if (
          (node.function.schema && node.function.schema !== "pg_catalog") ||
          !safeFunctions.has(node.function.name)
        )
          fail("SQL function is not supported");
        if (node.over) shape(node.over, ["partitionBy", "orderBy"]);
        return {
          type: node.type,
          function: { name: node.function.name, schema: node.function.schema },
          args: array(node.args, expr),
          distinct: optional(node.distinct, (v) =>
            enumValue(v, ["all", "distinct"]),
          ),
          orderBy: optional(node.orderBy, (v) => array(v, order)),
          filter: optional(node.filter, expr),
          withinGroup: optional(node.withinGroup, order),
          over: node.over && {
            partitionBy: optional(node.over.partitionBy, (v) => array(v, expr)),
            orderBy: optional(node.over.orderBy, (v) => array(v, order)),
          },
        };
      }
      default:
        return fail("SQL expression is not supported");
    }
  };
  const output = statement(root, true);
  if (parameters.size !== parameterCount)
    fail("Every SQL parameter must be referenced");
  // System values are authored by Polpo after validating every caller expression.
  const expression = (text: string) =>
    parseSql(`SELECT ${text}`)[0].columns[0].expr;
  const revisionSets = [
    {
      column: { name: "_version" },
      value: expression(
        `${quote(target ?? "unused")}.${quote("_version")} + 1`,
      ),
    },
    { column: { name: "_updated_at" }, value: expression("now()") },
  ];
  if (output.type === "insert") {
    const id = expression("gen_random_uuid()");
    output.columns.push({ name: "_id" });
    if (output.insert.type === "values")
      output.insert.values.forEach((row: any[]) => row.push(id));
    else if (
      output.insert.type === "select" &&
      output.insert.columns?.every(
        (c: any) => c.expr.type !== "ref" || c.expr.name !== "*",
      )
    )
      output.insert.columns.push({ expr: id });
    else return fail("INSERT supports VALUES or SELECT with explicit columns");
    if (output.onConflict?.do && output.onConflict.do !== "do nothing") {
      revisionSets[0].value = expression(
        `${quote(root.into.alias ?? target)}.${quote("_version")} + 1`,
      );
      output.onConflict.do.sets.push(...revisionSets);
    }
  }
  if (output.type === "update") {
    const alias = root.table.alias ?? target;
    revisionSets[0].value = expression(
      `${quote(alias)}.${quote("_version")} + 1`,
    );
    output.sets.push(...revisionSets);
  }
  if (write && !output.returning)
    output.returning = [{ expr: { type: "ref", name: "*" } }];
  try {
    return { sql: toSql.statement(output), write };
  } catch {
    return fail("SQL construct cannot be serialized");
  }
}

/** DDL is translated into the supported portable schema, then generated from it. */
export function migrationStatement(
  sql: string,
  namespace: string,
  schema: DataSchemaDefinition,
  destructive: boolean,
): string[] | null {
  const nodes = parseSql(sql);
  if (nodes.length !== 1)
    return fail("Each migration item must contain one statement");
  const node = nodes[0];
  boundedTree(node);
  if (["insert", "update", "delete"].includes(node.type)) return null;
  const qtable = (name: string) => `${quote(namespace)}.${quote(name)}`;
  const existing = (name: any) => {
    const key = plainName(name);
    if (!Object.hasOwn(schema.tables, key)) fail("Unknown migration table");
    return key;
  };
  const danger = () => {
    if (!destructive) fail("This migration requires allowDestructive: true");
  };
  const column = (node: any): [string, DataColumn] => {
    if (node.kind !== "column" || node.collate)
      return fail("Unsupported column definition");
    const name = userName(node.name.name);
    const result: DataColumn = { type: sqlType(node.dataType), nullable: true };
    for (const c of node.constraints ?? []) {
      if (c.type === "not null") delete result.nullable;
      else if (c.type === "null") result.nullable = true;
      else if (c.type === "unique") result.unique = true;
      else if (
        c.type === "reference" &&
        c.foreignColumns?.length === 1 &&
        !c.onDelete &&
        !c.onUpdate &&
        !c.deferrable
      ) {
        result.references = {
          table: plainName(c.foreignTable),
          column: c.foreignColumns[0].name,
        };
      } else
        fail(
          "Supported column constraints are NOT NULL, UNIQUE and REFERENCES",
        );
    }
    return [name, result];
  };
  const definition = (name: string, c: DataColumn) =>
    `${quote(name)} ${sqlTypes[c.type]}${c.nullable ? "" : " NOT NULL"}${c.unique ? " UNIQUE" : ""}${dataValueConstraint(name, c)}${c.references ? ` REFERENCES ${qtable(c.references.table)} (${quote(c.references.column)}) ON DELETE RESTRICT` : ""}`;
  const output: string[] = [];
  if (node.type === "create table") {
    const name = plainName(node.name);
    if (
      Object.hasOwn(schema.tables, name) ||
      node.constraints?.length ||
      node.inherits ||
      node.like ||
      node.temporary ||
      node.ifNotExists
    )
      return fail(
        "CREATE TABLE requires a new ordinary table with column constraints",
      );
    const columns: Record<string, DataColumn> = {};
    for (const c of node.columns) {
      const [name, value] = column(c);
      if (Object.hasOwn(columns, name)) fail("Duplicate column");
      columns[name] = value;
    }
    schema.tables[name] = { columns };
    output.push(
      `CREATE TABLE ${qtable(name)} ("_id" uuid PRIMARY KEY, "_version" integer NOT NULL DEFAULT 1, "_created_at" timestamptz NOT NULL DEFAULT now(), "_updated_at" timestamptz NOT NULL DEFAULT now()${Object.entries(
        columns,
      )
        .map(([n, c]) => `, ${definition(n, c)}`)
        .join("")})`,
    );
  } else if (node.type === "alter table") {
    let name = existing(node.table);
    if (node.ifExists || node.only)
      return fail("Conditional/ONLY ALTER TABLE is not supported");
    for (const c of node.changes) {
      const t = schema.tables[name];
      if (c.type === "add column") {
        if (c.ifNotExists) fail("Conditional ADD COLUMN is not supported");
        const [n, value] = column(c.column);
        if (Object.hasOwn(t.columns, n)) fail("Column already exists");
        t.columns[n] = value;
        output.push(
          `ALTER TABLE ${qtable(name)} ADD COLUMN ${definition(n, value)}`,
        );
      } else if (
        c.type === "drop column" ||
        c.type === "rename column" ||
        c.type === "alter column"
      ) {
        const n = userName(c.column.name);
        if (!Object.hasOwn(t.columns, n)) fail("Unknown migration column");
        if (c.type === "drop column") {
          danger();
          if (c.ifExists || c.behaviour === "cascade")
            fail("Conditional or cascading column drops are not supported");
          delete t.columns[n];
          t.indexes = t.indexes?.filter((i) => !i.columns.includes(n));
          output.push(
            `ALTER TABLE ${qtable(name)} DROP COLUMN ${quote(n)} RESTRICT`,
          );
        } else if (c.type === "rename column") {
          const to = userName(c.to.name);
          if (Object.hasOwn(t.columns, to)) fail("Column already exists");
          t.columns[to] = t.columns[n];
          delete t.columns[n];
          t.indexes?.forEach((i) => {
            i.columns = i.columns.map((x) => (x === n ? to : x));
          });
          for (const table of Object.values(schema.tables))
            for (const col of Object.values(table.columns))
              if (col.references?.table === name && col.references.column === n)
                col.references.column = to;
          output.push(
            `ALTER TABLE ${qtable(name)} RENAME COLUMN ${quote(n)} TO ${quote(to)}`,
          );
          if (dataValueConstraint(to, t.columns[to]))
            output.push(
              `ALTER TABLE ${qtable(name)} RENAME CONSTRAINT ${quote(dataValueConstraintName(n))} TO ${quote(dataValueConstraintName(to))}`,
            );
        } else if (
          c.alter.type === "set not null" ||
          c.alter.type === "drop not null"
        ) {
          if (c.alter.type === "set not null") delete t.columns[n].nullable;
          else t.columns[n].nullable = true;
          output.push(
            `ALTER TABLE ${qtable(name)} ALTER COLUMN ${quote(n)} ${c.alter.type.toUpperCase()}`,
          );
        } else if (c.alter.type === "set type") {
          danger();
          if (dataValueConstraint(n, t.columns[n]))
            output.push(
              `ALTER TABLE ${qtable(name)} DROP CONSTRAINT ${quote(dataValueConstraintName(n))}`,
            );
          t.columns[n].type = sqlType(c.alter.dataType);
          output.push(
            `ALTER TABLE ${qtable(name)} ALTER COLUMN ${quote(n)} TYPE ${sqlTypes[t.columns[n].type]}`,
          );
          const constraint = dataValueConstraint(n, t.columns[n]);
          if (constraint)
            output.push(`ALTER TABLE ${qtable(name)} ADD${constraint}`);
        } else fail("Unsupported ALTER COLUMN operation");
      } else if (c.type === "rename") {
        const to = userName(c.to.name);
        if (Object.hasOwn(schema.tables, to)) fail("Table already exists");
        schema.tables[to] = t;
        delete schema.tables[name];
        for (const table of Object.values(schema.tables))
          for (const col of Object.values(table.columns))
            if (col.references?.table === name) col.references.table = to;
        output.push(`ALTER TABLE ${qtable(name)} RENAME TO ${quote(to)}`);
        name = to;
      } else fail("Unsupported ALTER TABLE operation");
    }
  } else if (node.type === "create index") {
    const name = existing(node.table);
    const indexName = parseData(DataIndexName, node.indexName?.name);
    if (
      node.where ||
      (node.using && node.using.name !== "btree") ||
      node.concurrently ||
      node.ifNotExists ||
      node.tablespace
    )
      fail("Only ordinary column indexes are supported");
    const columns = node.expressions.map((e: any) => {
      if (
        e.expression.type !== "ref" ||
        e.expression.table ||
        e.order ||
        e.nulls ||
        e.collate ||
        e.opclass
      )
        return fail("Index must use plain columns");
      return userName(e.expression.name);
    });
    if (
      Object.values(schema.tables).some((t) =>
        t.indexes?.some((i) => i.name === indexName),
      )
    )
      fail("Index name already exists");
    (schema.tables[name].indexes ??= []).push({
      name: indexName,
      columns,
      ...(node.unique ? { unique: true } : {}),
    });
    output.push(
      `CREATE ${node.unique ? "UNIQUE " : ""}INDEX ${quote(indexName)} ON ${qtable(name)} (${columns.map(quote).join(",")})`,
    );
  } else if (node.type === "drop table" || node.type === "drop index") {
    danger();
    if (node.ifExists || node.cascade === "cascade" || node.concurrently)
      fail("Conditional or cascading drops are not supported");
    for (const n of node.names) {
      const name =
        node.type === "drop index" && !n.schema && !n.database
          ? parseData(DataIndexName, n.name)
          : plainName(n);
      if (node.type === "drop table") {
        existing(n);
        delete schema.tables[name];
        output.push(`DROP TABLE ${qtable(name)} RESTRICT`);
      } else {
        const table = Object.values(schema.tables).find((t) =>
          t.indexes?.some((i) => i.name === name),
        );
        if (!table) return fail("Unknown migration index");
        table.indexes = table.indexes!.filter((i) => i.name !== name);
        output.push(`DROP INDEX ${quote(namespace)}.${quote(name)} RESTRICT`);
      }
    }
  } else
    return fail(
      "Migration supports CREATE/ALTER/DROP TABLE, CREATE/DROP INDEX and record mutations",
    );
  parseData(DataSchema, schema);
  return output;
}
