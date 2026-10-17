/** Message for an unknown thrown value, with a caller-supplied fallback. */
export function describeError(
  err: unknown,
  fallback = "Unknown error"
): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
