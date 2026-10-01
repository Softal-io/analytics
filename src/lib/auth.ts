import { env } from "cloudflare:workers"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "@/db"
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
} from "@/db/schema"

export function isGoogleConfigured() {
  return Boolean(
    env.BETTER_AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
  )
}

function createAuth() {
  if (!env.BETTER_AUTH_SECRET)
    throw new Error("BETTER_AUTH_SECRET is not configured")
  return betterAuth({
    appName: "Web Analytics",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      transaction: false,
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    emailAndPassword: { enabled: false },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              prompt: "select_account",
            },
          }
        : {},
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 7 * 24 * 60 * 60, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: env.BETTER_AUTH_URL.startsWith("https:") },
  })
}

let instance: ReturnType<typeof createAuth> | undefined
export function getAuth() {
  instance ??= createAuth()
  return instance
}
