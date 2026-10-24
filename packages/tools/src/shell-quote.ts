/**
 * Quote a single argument for a POSIX shell command line.
 *
 * `Shell.execute` takes a full command line (not an argv), so every
 * model-controlled value interpolated into it must be single-quoted.
 * `JSON.stringify` is NOT a shell quote: double quotes still expand
 * `$(...)`, backticks and `$VAR`.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
