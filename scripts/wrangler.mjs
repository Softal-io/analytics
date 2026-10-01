import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const args = process.argv.slice(2)
const hasConfig = args.some(
  (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=")
)
const configPath = existsSync("wrangler.local.jsonc")
  ? "wrangler.local.jsonc"
  : "wrangler.jsonc"
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
