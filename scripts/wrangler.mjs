import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { prepareDeploymentConfig } from "./deployment-config.mjs"

const args = process.argv.slice(2)
// Global options may precede the command. Leave command-specific parsing to Wrangler.
const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  strict: false,
  options: {
    config: { type: "string", short: "c" },
    cwd: { type: "string" },
    env: { type: "string", short: "e" },
    "env-file": { type: "string", multiple: true },
    profile: { type: "string" },
  },
})
const hasConfig = values.config !== undefined
const production =
  ["deploy", "secret", "versions", "triggers"].includes(positionals[0]) ||
  (positionals[0] === "d1" &&
    !args.includes("--local") &&
    !["create", "list"].includes(positionals[1]))
const configPath = hasConfig
  ? undefined
  : prepareDeploymentConfig({ production })
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    ...(hasConfig ? [] : ["--config", configPath]),
    ...args,
  ],
  { stdio: "inherit" }
)
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
