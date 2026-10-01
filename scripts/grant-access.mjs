import { spawnSync } from "node:child_process"
import { grantAccessSql } from "../src/lib/access-grant-sql.js"

const [emailInput, role = "admin", scope = "--local"] = process.argv.slice(2)
const email = emailInput?.trim().toLowerCase()
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  email.length > 254 ||
  !["admin", "viewer"].includes(role) ||
  !["--local", "--remote"].includes(scope) ||
  process.argv.length > 5
) {
  console.error(
    "Usage: npm run access:grant -- name@example.com admin|viewer --local|--remote"
  )
  process.exit(1)
}
const quotedEmail = email.replaceAll("'", "''")
const command = grantAccessSql.replace(
  "VALUES (?, ?,",
  `VALUES ('${quotedEmail}', '${role}',`
)
const result = spawnSync(
  process.execPath,
  [
    "scripts/wrangler.mjs",
    "d1",
    "execute",
    "DB",
    scope,
    "--command",
    command,
    "--json",
  ],
  { encoding: "utf8" }
)
if (result.status !== 0) {
  console.error(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}
const output = JSON.parse(result.stdout)
const rows = output.flatMap((item) => item.results ?? [])
if (!rows.length) {
  console.error(
    "Access was not changed. Keep at least one admin who has signed in."
  )
  process.exit(1)
}
console.log(`Granted ${role} access to ${email} (${scope.slice(2)}).`)
