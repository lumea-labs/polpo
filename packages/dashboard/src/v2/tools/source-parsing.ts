export function extractStringProperty(source: string, property: string): string {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${escapedProperty}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
  );
  const match = source.match(re);
  if (!match) return "";
  return match[2]
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'\`\\])/g, "$1");
}

export const extractName = (source: string) =>
  extractStringProperty(source, "name");

export const extractDescription = (source: string) =>
  extractStringProperty(source, "description");
