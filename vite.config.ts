import { existsSync } from "node:fs"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import tsconfigPaths from "vite-tsconfig-paths"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { cloudflare } from "@cloudflare/vite-plugin"

const config = defineConfig({
  environments: {
    ssr: {
      build: {
        // Keep database classes together to preserve initialization order in workerd.
        rolldownOptions: { output: { codeSplitting: false } },
      },
    },
  },
  plugins: [
    devtools(),
    cloudflare({
      configPath: existsSync("wrangler.local.jsonc")
        ? "wrangler.local.jsonc"
        : "wrangler.jsonc",
      viteEnvironment: { name: "ssr" },
    }),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
