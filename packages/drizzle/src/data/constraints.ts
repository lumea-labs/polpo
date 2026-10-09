import type { DataColumn } from "@polpo-ai/core/data";

// Names have already passed the canonical identifier validator.
export const dataValueConstraintName = (name: string) => `polpo_value_${name}`;
export const finiteDataJson = (value: string) =>
  `NOT jsonb_path_exists(${value}, '$.** ? (@.type() == "number" && (@ > 1.7976931348623157e308 || @ < -1.7976931348623157e308))')`;
export function dataValueConstraint(name: string, column: DataColumn): string {
  const value = `"${name}"`;
  const check =
    column.type === "text"
      ? `octet_length(${value}) <= 65536`
      : column.type === "number"
        ? `${value} NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`
        : column.type === "timestamp"
          ? `isfinite(${value}) AND ${value} >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND ${value} < TIMESTAMPTZ '10000-01-01 00:00:00+00'`
          : column.type === "json"
            ? finiteDataJson(value)
            : undefined;
  return check
    ? ` CONSTRAINT "${dataValueConstraintName(name)}" CHECK (${check})`
    : "";
}
