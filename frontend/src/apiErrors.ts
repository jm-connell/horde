/**
 * FastAPI answers request-validation failures (HTTP 422) with
 * `{"detail": [{"type", "loc": ["body", "field"], "msg", "input"}, ...]}`.
 * Turn that into a sentence a person can read; returns null for any other
 * shape so callers keep their existing handling.
 */
export function formatValidationDetail(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const parts: string[] = [];
  for (const item of detail) {
    if (typeof item !== "object" || item === null) return null;
    const { loc, msg } = item as { loc?: unknown; msg?: unknown };
    if (typeof msg !== "string") return null;
    const path = Array.isArray(loc)
      ? loc
          .filter((p): p is string | number => {
            return typeof p === "string" || typeof p === "number";
          })
          // The first segment only says where the field lives in the request.
          .filter(
            (p, i) =>
              !(i === 0 && ["body", "query", "path"].includes(String(p)))
          )
          .join(".")
      : "";
    parts.push(path ? `${path}: ${msg}` : msg);
  }
  return parts.join("; ");
}

/** Message for an unknown thrown value, with a caller-supplied fallback. */
export function describeError(
  err: unknown,
  fallback = "Unknown error"
): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
