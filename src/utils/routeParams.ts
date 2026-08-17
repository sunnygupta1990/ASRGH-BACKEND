// backened/src/utils/routeParams.ts

export function normalizeParam(
  value: string | string[] | undefined,
): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
