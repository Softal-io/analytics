import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import { resolve } from "node:path"
import { parseEnv } from "node:util"
import ts from "typescript"

const placeholderId = "00000000-0000-0000-0000-000000000000"

/**
 * Build tooling only. Runtime credentials never enter the generated config.
 * @param {{ production?: boolean, root?: string, environment?: Record<string, string | undefined> }} options
 */
export function prepareDeploymentConfig({
  production = false,
  root = process.cwd(),
  environment = process.env,
} = {}) {
  const templatePath = resolve(root, "wrangler.jsonc")
  const parsed = ts.parseConfigFileTextToJson(
    templatePath,
    readFileSync(templatePath, "utf8")
  )
  if (parsed.error) throw new Error("Invalid JSONC in wrangler.jsonc")
  const config = parsed.config
  const localPath = resolve(root, ".deployment.env.local")
  const inCI = [environment.CI, environment.WORKERS_CI].some(
    (value) => value === "true" || value === "1"
  )
  const local =
    !inCI && existsSync(localPath)
      ? parseEnv(readFileSync(localPath, "utf8"))
      : {}
  const input = (name) => (environment[name] ?? local[name] ?? "").trim()
  const originInput = input("ANALYTICS_ORIGIN")
  const databaseId = input("D1_DATABASE_ID")
  const accountId = input("CLOUDFLARE_ACCOUNT_ID")

  if (production && (!originInput || !databaseId)) {
    throw new Error(
      "Set ANALYTICS_ORIGIN and D1_DATABASE_ID in Cloudflare build variables or .deployment.env.local before building or using production commands."
    )
  }
  if (
    databaseId &&
    (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      databaseId
    ) ||
      databaseId === placeholderId)
  )
    throw new Error("D1_DATABASE_ID must be a real D1 database UUID")
  if (accountId && !/^[\da-f]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID")
  }

  let origin
  try {
    origin = new URL(originInput || "http://localhost:3006")
  } catch {
    throw new Error(
      "ANALYTICS_ORIGIN must be a URL origin, such as https://analytics.example.com"
    )
  }
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !["http:", "https:"].includes(origin.protocol) ||
    (production &&
      (origin.protocol !== "https:" ||
        origin.port ||
        isIP(origin.hostname.replace(/^\[|\]$/g, "")) ||
        !origin.hostname.includes(".") ||
        !origin.hostname
          .split(".")
          .every((label) =>
            /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)
          ) ||
        origin.hostname === "localhost" ||
        origin.hostname.endsWith(".localhost") ||
        origin.hostname === "analytics.example.com"))
  ) {
    throw new Error(
      "ANALYTICS_ORIGIN must be your HTTPS domain without a path, credentials, query, or port"
    )
  }

  const databases = config.d1_databases?.filter((db) => db.binding === "DB")
  if (databases?.length !== 1) {
    throw new Error("wrangler.jsonc must declare exactly one DB binding")
  }
  databases[0].database_id = databaseId || placeholderId
  config.vars = {
    ...config.vars,
    BETTER_AUTH_URL: production ? origin.origin : "http://localhost:3006",
    TRACKER_ORIGIN: production ? origin.origin : "http://localhost:3006",
  }
  config.routes = production
    ? [{ pattern: origin.hostname, custom_domain: true }]
    : []
  if (accountId) config.account_id = accountId

  const configPath = resolve(
    root,
    production ? "wrangler.local.jsonc" : "wrangler.dev.local.jsonc"
  )
  const contents = `${JSON.stringify(config, null, 2)}\n`
  // Avoid restarting Vite's config watcher for unchanged local CLI commands.
  if (
    !existsSync(configPath) ||
    readFileSync(configPath, "utf8") !== contents
  ) {
    writeFileSync(configPath, contents, { mode: 0o600 })
  }
  return configPath
}
