import type { paths } from "./schema";

/**
 * Types read straight from the generated OpenAPI paths (`schema.d.ts`). A route
 * that is renamed or removed on the server makes the `P` argument stop type
 * checking, so a stale call site fails `tsc` instead of failing at runtime.
 */
export type ApiPath = keyof paths;
type Method = "get" | "post" | "put" | "patch" | "delete";

type Op<P extends ApiPath, M extends Method> = paths[P] extends {
  [K in M]: infer O;
}
  ? O
  : never;

/** JSON body of a successful (200/201) response. */
export type ApiResponse<P extends ApiPath, M extends Method> =
  Op<P, M> extends {
    responses: infer R;
  }
    ? R extends { 200: { content: { "application/json": infer B } } }
      ? B
      : R extends { 201: { content: { "application/json": infer B } } }
        ? B
        : never
    : never;

/** JSON request body. */
export type ApiBody<P extends ApiPath, M extends Method> =
  Op<P, M> extends {
    requestBody?: { content: { "application/json": infer B } };
  }
    ? B
    : never;

/** Query string parameters. */
export type ApiQuery<P extends ApiPath, M extends Method> =
  Op<P, M> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;
