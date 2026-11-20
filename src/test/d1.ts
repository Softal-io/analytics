import { DatabaseSync } from "node:sqlite"
import { readFileSync, readdirSync } from "node:fs"
import type { Mock } from "vitest"

type Value = string | number

/** An in-memory SQLite database with every migration applied. */
export function openTestDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  const migrations = new URL("../../drizzle/", import.meta.url)
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort())
    database.exec(readFileSync(new URL(file, migrations), "utf8"))
  return database
}

/**
 * Backs a mocked D1 binding with SQLite. A batch is one transaction, as on
 * D1. `onStatement` sees each statement as it is prepared and as it is bound.
 */
export function mockD1(
  d1: { prepare: Mock; batch: Mock },
  database: () => DatabaseSync,
  onStatement?: (query: string, values: Array<Value>) => void
) {
  d1.prepare.mockImplementation((query: string) => {
    const prepare = (values: Array<Value> = []) => {
      onStatement?.(query, values)
      return {
        bind: (...bound: Array<Value>) => prepare(bound),
        all: () =>
          Promise.resolve({
            results: database()
              .prepare(query)
              .all(...values),
          }),
        run: () =>
          Promise.resolve({
            meta: database()
              .prepare(query)
              .run(...values),
            results: [],
          }),
        raw: () => {
          const statement = database().prepare(query)
          statement.setReturnArrays(true)
          return Promise.resolve(statement.all(...values))
        },
      }
    }
    return prepare()
  })
  d1.batch.mockImplementation(
    async (statements: Array<{ run: () => Promise<unknown> }>) => {
      database().exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        database().exec("COMMIT")
        return results
      } catch (error) {
        database().exec("ROLLBACK")
        throw error
      }
    }
  )
}
