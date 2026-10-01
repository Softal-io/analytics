/** Drizzle wraps D1 constraint errors in one or more error causes. */
export function isUniqueConstraintError(
  error: unknown,
  column: string
): boolean {
  const seen = new Set<Error>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (
      current.message.includes("UNIQUE constraint failed") &&
      current.message.includes(column)
    )
      return true
    current = current.cause
  }
  return false
}
