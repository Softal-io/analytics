import { env } from "cloudflare:workers"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm"

const dialect = new SQLiteAsyncDialect()

/** D1 batches are transactions: dependent writes and cache invalidation commit together. */
export function prepareStatement(statement: SQL): D1PreparedStatement {
  const { sql, params } = dialect.sqlToQuery(statement)
  return env.DB.prepare(sql).bind(...params)
}

export function runBatch(statements: Array<SQL>) {
  return env.DB.batch(statements.map(prepareStatement))
}
