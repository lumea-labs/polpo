/** Keep the selected record page within the server's current total. */
export function dataPageOffset(offset: number, total: number, pageSize = 25) {
  const lastOffset = Math.floor(Math.max(0, total - 1) / pageSize) * pageSize;
  return Math.min(offset, lastOffset);
}
