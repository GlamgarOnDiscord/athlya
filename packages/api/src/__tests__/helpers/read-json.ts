/**
 * Typed JSON reader for test responses.
 *
 * `@cloudflare/workers-types` types `Response.json()` as
 * `Promise<unknown>`, so every call site that inspects the body must
 * narrow the shape. Pinning the parameter's `json()` to
 * `Promise<unknown>` here makes the single assertion below a genuine
 * `unknown -> T` narrowing that both `tsc` and
 * `@typescript-eslint/no-unnecessary-type-assertion` agree is
 * necessary — avoiding the projectService-vs-tsc divergence that makes
 * the rule misfire on an inline `(await res.json()) as T` under the
 * `WebWorker` + workers-types lib combo.
 */
export async function readJson<T>(res: { json(): Promise<unknown> }): Promise<T> {
  return (await res.json()) as T;
}
