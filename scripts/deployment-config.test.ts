import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { prepareDeploymentConfig } from "./deployment-config.mjs"

const databaseId = "12345678-1234-1234-1234-123456789abc"
const inputs = {
  ANALYTICS_ORIGIN: "https://stats.example.org/",
  D1_DATABASE_ID: databaseId,
}
let root: string
function generated(production = true) {
  return JSON.parse(
    readFileSync(
      join(
        root,
        production ? "wrangler.local.jsonc" : "wrangler.dev.local.jsonc"
      ),
      "utf8"
    )
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "analytics-config-test-"))
  writeFileSync(join(root, "wrangler.jsonc"), readFileSync("wrangler.jsonc"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("deployment configuration", () => {
  it("derives the route and both runtime origins from one build variable", () => {
    prepareDeploymentConfig({ root, production: true, environment: inputs })
    const config = generated()
    expect(config.routes).toEqual([
      { pattern: "stats.example.org", custom_domain: true },
    ])
    expect(config.vars).toMatchObject({
      BETTER_AUTH_URL: "https://stats.example.org",
      TRACKER_ORIGIN: "https://stats.example.org",
    })
    expect(config.d1_databases[0].database_id).toBe(databaseId)
    expect(config.durable_objects.bindings[0].name).toBe("LIVE_VISITORS")
    expect(config.triggers.crons).toEqual(["10 * * * *"])
  })

  it("keeps future shared bindings and variables instead of freezing a private copy", () => {
    prepareDeploymentConfig({ root, production: true, environment: inputs })
    const template = generated()
    template.vars.FEATURE = "enabled"
    template.kv_namespaces = [{ binding: "CACHE", id: "test-id" }]
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(template))
    prepareDeploymentConfig({ root, production: true, environment: inputs })
    expect(generated().kv_namespaces).toEqual(template.kv_namespaces)
    expect(generated().vars.FEATURE).toBe("enabled")
  })

  it("allows local development without a Cloudflare account", () => {
    prepareDeploymentConfig({ root, environment: {} })
    expect(generated(false).vars.BETTER_AUTH_URL).toBe("http://localhost:3006")
    expect(generated(false).routes).toEqual([])
  })

  it("uses private local inputs, with shell variables taking precedence", () => {
    writeFileSync(
      join(root, ".deployment.env.local"),
      `ANALYTICS_ORIGIN="https://local.example.org"\nD1_DATABASE_ID="${databaseId}"`
    )
    prepareDeploymentConfig({
      root,
      production: true,
      environment: { ANALYTICS_ORIGIN: inputs.ANALYTICS_ORIGIN },
    })
    expect(generated().vars.BETTER_AUTH_URL).toBe("https://stats.example.org")
    expect(generated().d1_databases[0].database_id).toBe(databaseId)
    prepareDeploymentConfig({ root, environment: {} })
    expect(generated(false).d1_databases[0].database_id).toBe(databaseId)
    expect(generated(false).vars.TRACKER_ORIGIN).toBe("http://localhost:3006")
    expect(generated().vars.TRACKER_ORIGIN).toBe("https://stats.example.org")
    expect(generated().routes).toHaveLength(1)
  })

  it("does not let a local file hide missing CI configuration or reuse a stale output", () => {
    writeFileSync(
      join(root, ".deployment.env.local"),
      `ANALYTICS_ORIGIN="${inputs.ANALYTICS_ORIGIN}"\nD1_DATABASE_ID="${databaseId}"`
    )
    writeFileSync(join(root, "wrangler.local.jsonc"), "{}")
    expect(() =>
      prepareDeploymentConfig({
        root,
        production: true,
        environment: { WORKERS_CI: "1" },
      })
    ).toThrow("Set ANALYTICS_ORIGIN and D1_DATABASE_ID")
    expect(generated()).toEqual({})
  })

  it("does not copy credentials or private build inputs into runtime variables", () => {
    prepareDeploymentConfig({
      root,
      production: true,
      environment: {
        ...inputs,
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        GOOGLE_CLIENT_SECRET: "private-google-secret",
        BETTER_AUTH_SECRET: "private-auth-secret",
      },
    })
    expect(generated().account_id).toBe("a".repeat(32))
    expect(Object.keys(generated().vars).sort()).toEqual([
      "BETTER_AUTH_URL",
      "TRACKER_ORIGIN",
    ])
    expect(JSON.stringify(generated())).not.toContain("private-google-secret")
    expect(JSON.stringify(generated())).not.toContain("private-auth-secret")
  })

  it.each([
    { D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" },
    { D1_DATABASE_ID: "not-a-uuid" },
    { ANALYTICS_ORIGIN: "http://stats.example.org" },
    { ANALYTICS_ORIGIN: "https://stats.example.org/path" },
    { ANALYTICS_ORIGIN: "https://stats.example.org?query=1" },
    { ANALYTICS_ORIGIN: "https://stats.example.org#hash" },
    { ANALYTICS_ORIGIN: "https://user:password@stats.example.org" },
    { ANALYTICS_ORIGIN: "https://localhost" },
    { ANALYTICS_ORIGIN: "https://127.0.0.1" },
    { ANALYTICS_ORIGIN: "https://[::1]" },
    { ANALYTICS_ORIGIN: "https://internal" },
    { ANALYTICS_ORIGIN: "https://invalid_host.example.org" },
    { ANALYTICS_ORIGIN: "https://stats.example.org:3000" },
    { ANALYTICS_ORIGIN: "https://analytics.example.com" },
    { CLOUDFLARE_ACCOUNT_ID: "not-an-account-id" },
  ])("rejects invalid production inputs: %j", (override) => {
    expect(() =>
      prepareDeploymentConfig({
        root,
        production: true,
        environment: { ...inputs, ...override },
      })
    ).toThrow()
    expect(() => generated()).toThrow()
  })

  it("fails when the shared template loses the DB binding", () => {
    writeFileSync(join(root, "wrangler.jsonc"), '{"d1_databases":[]}')
    expect(() =>
      prepareDeploymentConfig({ root, production: true, environment: inputs })
    ).toThrow("exactly one DB binding")
  })
})
