import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "analytics-wrangler-test-"))
  mkdirSync(join(root, "scripts"))
  for (const file of [
    "package.json",
    "wrangler.jsonc",
    "scripts/wrangler.mjs",
    "scripts/deployment-config.mjs",
  ]) {
    copyFileSync(file, join(root, file))
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function triggersDryRun(inputs: Record<string, string>, prefix: Array<string> = []) {
  const environment = { ...process.env }
  for (const name of [
    "ANALYTICS_ORIGIN",
    "D1_DATABASE_ID",
    "CLOUDFLARE_ACCOUNT_ID",
  ]) {
    delete environment[name]
  }
  return spawnSync(
    process.execPath,
    ["scripts/wrangler.mjs", ...prefix, "triggers", "deploy", "--dry-run"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...environment,
        ...inputs,
        WORKERS_CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(root, "wrangler.log"),
      },
    }
  )
}

it.each([[], ["--cwd", "."]])(
  "uses the production domain for trigger deployment with prefix %j",
  (...prefix) => {
    const result = triggersDryRun(
      {
        ANALYTICS_ORIGIN: "https://stats.example.org",
        D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
      },
      prefix
    )
    expect(result.stderr + result.stdout).toContain("--dry-run: exiting now.")
    expect(result.status).toBe(0)
    const config = JSON.parse(
      readFileSync(join(root, "wrangler.local.jsonc"), "utf8")
    )
    expect(config.routes).toEqual([
      { pattern: "stats.example.org", custom_domain: true },
    ])
    expect(config.vars.BETTER_AUTH_URL).toBe("https://stats.example.org")
    expect(existsSync(join(root, "wrangler.dev.local.jsonc"))).toBe(false)
  }
)

it("blocks trigger deployment without production inputs before invoking Wrangler", () => {
  const result = triggersDryRun({})
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Set ANALYTICS_ORIGIN and D1_DATABASE_ID")
  expect(result.stdout).not.toContain("--dry-run: exiting now.")
  expect(existsSync(join(root, "wrangler.local.jsonc"))).toBe(false)
})
